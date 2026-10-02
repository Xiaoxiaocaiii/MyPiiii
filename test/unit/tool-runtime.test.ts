import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { JsonValue } from '../../src/core/contracts.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import {
  executeToolCall,
  type ToolCallAction,
  type ToolExecutionOptions,
} from '../../src/core/tool-runtime.js';
import type { ToolDefinition } from '../../src/core/tool.js';

type SearchInput = { query: string };
type SearchOutput = { matches: string[] };

const action: ToolCallAction = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-1',
  toolName: 'repository.search',
  args: { query: ' runtime ' },
};

function createOptions(now = vi.fn().mockReturnValueOnce(10).mockReturnValue(17)) {
  const controller = new AbortController();
  const options: ToolExecutionOptions = {
    context: {
      scenarioId: 'repo-qa',
      signal: controller.signal,
    },
    enabledTools: ['repository.search'],
    now,
  };

  return options;
}

function createSearchTool(
  execute = vi.fn<(input: SearchInput) => Promise<SearchOutput>>(() =>
    Promise.resolve({ matches: [' result '] }),
  ),
): ToolDefinition<SearchInput, SearchOutput> {
  return {
    schemaVersion: 1,
    name: 'repository.search',
    description: 'Search repository content',
    inputSchema: z.strictObject({ query: z.string().trim().min(1) }),
    outputSchema: z.strictObject({
      matches: z.array(z.string().trim().min(1)),
    }),
    timeoutMs: 1_000,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute,
  };
}

describe('executeToolCall schema boundaries', () => {
  it('normalizes input and validated output before creating a success observation', async () => {
    const execute = vi.fn<(input: SearchInput) => Promise<SearchOutput>>(() =>
      Promise.resolve({ matches: [' result '] }),
    );
    const registry = new ToolRegistry([createSearchTool(execute)]);

    const observation = await executeToolCall(action, registry, createOptions());

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { query: 'runtime' },
      expect.objectContaining({ scenarioId: 'repo-qa' }),
    );
    expect(observation).toEqual({
      schemaVersion: 1,
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'repository.search',
      data: { matches: ['result'] },
      truncated: false,
      durationMs: 7,
    });
  });

  it('rejects invalid input without executing the tool or exposing validation details', async () => {
    const execute = vi.fn<(input: SearchInput) => Promise<SearchOutput>>();
    const registry = new ToolRegistry([createSearchTool(execute)]);
    const invalidAction: ToolCallAction = {
      ...action,
      args: { query: 42, secret: 'private-input' },
    };

    const observation = await executeToolCall(invalidAction, registry, createOptions());

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toEqual({
      schemaVersion: 1,
      type: 'tool_error',
      callId: 'call-1',
      toolName: 'repository.search',
      code: 'INPUT_INVALID',
      message: 'The tool input is invalid',
      retryable: false,
      durationMs: 7,
    });
    expect(JSON.stringify(observation)).not.toContain('private-input');
  });

  it('rejects output that fails the tool output schema without exposing it', async () => {
    const tool = {
      ...createSearchTool(),
      execute: () => Promise.resolve({ secret: 'private-output' }),
    } as unknown as ToolDefinition<SearchInput, SearchOutput>;
    const registry = new ToolRegistry([tool]);

    const observation = await executeToolCall(action, registry, createOptions());

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'OUTPUT_INVALID',
      message: 'The tool returned an invalid output',
      retryable: false,
    });
    expect(JSON.stringify(observation)).not.toContain('private-output');
  });

  it('rejects output accepted by a tool schema when it is not JSON-safe', async () => {
    const tool: ToolDefinition<SearchInput, JsonValue> = {
      ...createSearchTool(),
      outputSchema: z.custom<JsonValue>(() => true),
      execute: () => Promise.resolve(new Date('2026-09-18') as unknown as JsonValue),
    };
    const registry = new ToolRegistry([tool]);

    const observation = await executeToolCall(action, registry, createOptions());

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'OUTPUT_INVALID',
      message: 'The tool returned an invalid output',
    });
    expect(JSON.stringify(observation)).not.toContain('2026-09-18');
  });
});
