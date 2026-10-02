import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createToolContext } from '../../src/core/tool-permissions.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import {
  executeToolCall,
  type ToolCallAction,
  type ToolExecutionOptions,
} from '../../src/core/tool-runtime.js';
import type { ToolContext, ToolDefinition } from '../../src/core/tool.js';

type TestInput = { value: string };
type TestOutput = { value: string };

const action: ToolCallAction = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-1',
  toolName: 'test.tool',
  args: { value: 'input' },
};

afterEach(() => {
  vi.useRealTimers();
});

function createTool(
  execute: (input: TestInput, context: ToolContext) => Promise<TestOutput>,
  timeoutMs = 25,
): ToolDefinition<TestInput, TestOutput> {
  return {
    schemaVersion: 1,
    name: 'test.tool',
    description: 'Exercise execution boundaries',
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    timeoutMs,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute,
  };
}

function createOptions(controller = new AbortController()): ToolExecutionOptions {
  return {
    context: createToolContext({
      scenarioId: 'repo-qa',
      signal: controller.signal,
    }),
    enabledTools: ['test.tool'],
  };
}

describe('tool execution error normalization', () => {
  it('clears execution resources after a successful call', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const registry = new ToolRegistry([
      createTool((input) => Promise.resolve({ value: input.value })),
    ]);

    const observation = await executeToolCall(action, registry, createOptions(controller));

    expect(observation).toMatchObject({
      type: 'tool_result',
      data: { value: 'input' },
    });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      name: 'a synchronous exception',
      execute: () => {
        throw new TypeError('token=private-sync');
      },
    },
    {
      name: 'an asynchronous rejection',
      execute: () => Promise.reject(new Error('token=private-async')),
    },
    {
      name: 'a non-Error rejection',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- verifies boundary normalization.
      execute: () => Promise.reject('token=private-string'),
    },
  ])('normalizes $name', async ({ execute }) => {
    vi.useFakeTimers();
    const registry = new ToolRegistry([createTool(execute)]);

    const observation = await executeToolCall(action, registry, createOptions());

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
      message: 'The tool execution failed',
      retryable: true,
    });
    expect(JSON.stringify(observation)).not.toContain('private');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out, aborts the tool signal, and ignores a late result', async () => {
    vi.useFakeTimers();
    let toolSignal: AbortSignal | undefined;
    let resolveLate: ((output: TestOutput) => void) | undefined;
    const execute = vi.fn(
      (_input: TestInput, context: ToolContext) =>
        new Promise<TestOutput>((resolveOutput) => {
          toolSignal = context.signal;
          resolveLate = resolveOutput;
        }),
    );
    const registry = new ToolRegistry([createTool(execute)]);

    const execution = executeToolCall(action, registry, createOptions());
    await vi.advanceTimersByTimeAsync(25);
    const observation = await execution;

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'TIMEOUT',
      message: 'The tool call timed out',
      retryable: true,
    });
    expect(toolSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    resolveLate?.({ value: 'late-private-output' });
    await Promise.resolve();
    expect(JSON.stringify(observation)).not.toContain('late-private-output');
  });

  it('links external cancellation without exposing its reason', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    let toolSignal: AbortSignal | undefined;
    const registry = new ToolRegistry([
      createTool(
        (_input, context) =>
          new Promise<TestOutput>(() => {
            toolSignal = context.signal;
          }),
      ),
    ]);

    const execution = executeToolCall(action, registry, createOptions(controller));
    await Promise.resolve();
    controller.abort('token=private-abort');
    const observation = await execution;

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
      message: 'The tool execution failed',
      retryable: true,
    });
    expect(JSON.stringify(observation)).not.toContain('private-abort');
    expect(toolSignal?.aborted).toBe(true);
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not invoke a tool when the parent signal is already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort('token=private-before-call');
    const execute = vi.fn(() => Promise.resolve({ value: 'must-not-run' }));
    const registry = new ToolRegistry([createTool(execute)]);

    const observation = await executeToolCall(action, registry, createOptions(controller));

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
    });
    expect(JSON.stringify(observation)).not.toContain('private-before-call');
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
