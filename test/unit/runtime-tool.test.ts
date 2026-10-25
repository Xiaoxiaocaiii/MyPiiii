import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ExperimentConfig } from '../../src/core/config.js';
import { FakeModelAdapter } from '../../src/core/fake-model.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { runAgent, type RuntimeInput } from '../../src/core/runtime.js';
import type { ToolContext, ToolDefinition } from '../../src/core/tool.js';

type SearchInput = { query: string };
type SearchOutput = { matches: string[] };

const config: ExperimentConfig = {
  schemaVersion: 1,
  configId: 'tool-runtime-test',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 1024,
  },
  runtime: {
    maxTurns: 3,
    timeoutMs: 1_000,
  },
  tools: {
    enabled: ['repository.search'],
  },
  artifacts: {
    directory: './artifacts',
  },
};

const input: RuntimeInput = {
  schemaVersion: 1,
  sessionId: 'tool-session',
  inputMessage: 'Find the runtime.',
  config,
};

afterEach(() => {
  vi.useRealTimers();
});

function toolCall(toolName = 'repository.search') {
  return {
    schemaVersion: 1 as const,
    type: 'tool_call' as const,
    callId: 'call-1',
    toolName,
    args: { query: ' runtime ' },
  };
}

function finalAnswer(content = 'Done') {
  return {
    schemaVersion: 1 as const,
    type: 'final_answer' as const,
    content,
  };
}

function createSearchTool(
  execute: (input: SearchInput, context: ToolContext) => Promise<SearchOutput>,
  timeoutMs = 100,
): ToolDefinition<SearchInput, SearchOutput> {
  return {
    schemaVersion: 1,
    name: 'repository.search',
    description: 'Search repository content',
    inputSchema: z.strictObject({ query: z.string().trim().min(1) }),
    outputSchema: z.strictObject({ matches: z.array(z.string().trim()) }),
    timeoutMs,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute,
  };
}

describe('runAgent tool loop', () => {
  it('executes a tool and feeds only its normalized observation into the next model request', async () => {
    const execute = vi.fn((toolInput: SearchInput, context: ToolContext) => {
      expect(Object.keys(context).sort()).toEqual(['scenarioId', 'signal']);
      expect(Object.isFrozen(context)).toBe(true);
      return Promise.resolve({ matches: [` ${toolInput.query} result `] });
    });
    const registry = new ToolRegistry([createSearchTool(execute)]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall() },
      },
      {
        type: 'response',
        response: { schemaVersion: 1, output: finalAnswer() },
      },
    ]);

    const result = await runAgent(input, adapter, {
      tools: { registry },
    });

    expect(result).toMatchObject({
      status: 'completed',
      finalOutput: 'Done',
      turns: [
        {
          turnIndex: 0,
          action: {
            ...toolCall(),
            args: { redacted: true },
          },
          observations: [
            {
              type: 'tool_result',
              callId: 'call-1',
              toolName: 'repository.search',
              data: { matches: ['runtime result'] },
              truncated: false,
            },
          ],
        },
        {
          turnIndex: 1,
          observations: [],
          stopReason: 'FINAL_ANSWER',
        },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(adapter.requests[0]?.tools).toEqual(
      registry.describeAvailable('repo-qa', ['repository.search']),
    );
    expect(adapter.requests[1]?.tools).toEqual(adapter.requests[0]?.tools);
    expect(adapter.requests[0]?.context?.visibleTools).toEqual(adapter.requests[0]?.tools);
    expect(adapter.requests[0]?.context?.observations).toEqual([]);
    expect(adapter.requests[1]?.context?.visibleTools).toEqual(adapter.requests[1]?.tools);
    expect(adapter.requests[0]).not.toHaveProperty('observations');
    expect(adapter.requests[1]).not.toHaveProperty('observations');
    expect(adapter.requests[1]?.context?.observations.map((entry) => entry.observation)).toEqual(
      result.turns[0]?.observations,
    );
    expect(adapter.requests[1]?.context?.observations[0]).toMatchObject({
      sourceTurnIndex: 0,
      callId: 'call-1',
      toolName: 'repository.search',
    });
    expect(JSON.stringify(adapter.requests[1])).not.toContain(' runtime result ');
  });

  it('hides disabled tools from the model and rejects attempts to call them', async () => {
    const visibleExecute = vi.fn(() => Promise.resolve({ matches: ['visible'] }));
    const hiddenExecute = vi.fn(() => Promise.resolve({ matches: ['hidden'] }));
    const visibleTool = createSearchTool(visibleExecute);
    const hiddenTool = {
      ...createSearchTool(hiddenExecute),
      name: 'repository.hidden',
    };
    const registry = new ToolRegistry([visibleTool, hiddenTool]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: toolCall('repository.hidden'),
        },
      },
      {
        type: 'response',
        response: { schemaVersion: 1, output: finalAnswer('Denied') },
      },
    ]);

    const result = await runAgent(input, adapter, { tools: { registry } });
    const visibleDescriptions = registry.describeAvailable('repo-qa', ['repository.search']);

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.tools).toEqual(visibleDescriptions);
    expect(adapter.requests[0]?.tools?.map(({ name }) => name)).toEqual(['repository.search']);
    expect(adapter.requests[1]?.tools).toEqual(visibleDescriptions);
    expect(adapter.requests[0]?.context?.visibleTools).toEqual(visibleDescriptions);
    expect(adapter.requests[1]?.context?.visibleTools).toEqual(visibleDescriptions);
    expect(result.turns[0]?.observations).toMatchObject([
      { type: 'tool_error', code: 'PERMISSION_DENIED' },
    ]);
    expect(visibleExecute).not.toHaveBeenCalled();
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it('feeds a tool validation error back to the model and continues', async () => {
    const execute = vi.fn(() => Promise.resolve({ matches: ['must-not-run'] }));
    const registry = new ToolRegistry([createSearchTool(execute)]);
    const invalidCall = {
      ...toolCall(),
      args: { query: 42, secret: 'private-input' },
    };
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: invalidCall },
      },
      {
        type: 'response',
        response: { schemaVersion: 1, output: finalAnswer('Recovered') },
      },
    ]);

    const result = await runAgent(input, adapter, { tools: { registry } });

    expect(result).toMatchObject({
      status: 'completed',
      finalOutput: 'Recovered',
    });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      action: { args: { redacted: true } },
      modelResponse: { args: { redacted: true } },
      observations: [
        {
          type: 'tool_error',
          code: 'INPUT_INVALID',
          message: 'The tool input is invalid',
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-input');
    expect(JSON.stringify(adapter.requests[1])).not.toContain('private-input');
  });

  it('feeds an unknown-tool error back to the model and continues', async () => {
    const registry = new ToolRegistry([
      createSearchTool((toolInput) => Promise.resolve({ matches: [toolInput.query] })),
    ]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall('missing.tool') },
      },
      {
        type: 'response',
        response: { schemaVersion: 1, output: finalAnswer('Recovered') },
      },
    ]);

    const result = await runAgent(input, adapter, { tools: { registry } });

    expect(result.status).toBe('completed');
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      observations: [
        {
          type: 'tool_error',
          code: 'TOOL_NOT_FOUND',
        },
      ],
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('preserves the unsupported action path when no Tool Runtime is injected', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall() },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_ACTION' },
      turns: [{ stopReason: 'UNSUPPORTED_ACTION', observations: [] }],
    });
    expect(adapter.requests[0]).not.toHaveProperty('tools');
  });

  it('preserves the unsupported action path when no tools are enabled', async () => {
    const execute = vi.fn(() => Promise.resolve({ matches: ['must-not-run'] }));
    const registry = new ToolRegistry([createSearchTool(execute)]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall() },
      },
    ]);
    const noToolInput: RuntimeInput = {
      ...input,
      config: {
        ...config,
        tools: { enabled: [] },
      },
    };

    const result = await runAgent(noToolInput, adapter, {
      tools: { registry },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_ACTION' },
    });
    expect(adapter.requests[0]).not.toHaveProperty('tools');
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies the whole-run timeout while a tool is executing', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(
      (_toolInput: SearchInput, context: ToolContext) =>
        new Promise<SearchOutput>((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = context.signal.reason;
              reject(reason instanceof Error ? reason : new Error('Tool aborted'));
            },
            {
              once: true,
            },
          );
        }),
    );
    const registry = new ToolRegistry([createSearchTool(execute, 1_000)]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall() },
      },
    ]);
    const timeoutInput: RuntimeInput = {
      ...input,
      config: {
        ...config,
        runtime: { ...config.runtime, timeoutMs: 25 },
      },
    };

    const run = runAgent(timeoutInput, adapter, { tools: { registry } });
    await vi.advanceTimersByTimeAsync(25);
    const result = await run;

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'RUN_TIMEOUT' },
      turns: [
        {
          observations: [{ type: 'tool_error', code: 'EXECUTION_FAILED' }],
          stopReason: 'RUN_TIMEOUT',
        },
      ],
    });
  });

  it('applies external cancellation while a tool is executing', async () => {
    const controller = new AbortController();
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const execute = vi.fn((_toolInput: SearchInput, context: ToolContext) => {
      const execution = new Promise<SearchOutput>((_, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            const reason: unknown = context.signal.reason;
            reject(reason instanceof Error ? reason : new Error('Tool aborted'));
          },
          {
            once: true,
          },
        );
      });
      markToolStarted();
      return execution;
    });
    const registry = new ToolRegistry([createSearchTool(execute)]);
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: toolCall() },
      },
    ]);

    const run = runAgent(input, adapter, {
      signal: controller.signal,
      tools: { registry },
    });
    await toolStarted;
    controller.abort('private cancellation reason');
    const result = await run;

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'ABORTED' },
      turns: [
        {
          observations: [{ type: 'tool_error', code: 'EXECUTION_FAILED' }],
          stopReason: 'ABORTED',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private cancellation reason');
  });
});
