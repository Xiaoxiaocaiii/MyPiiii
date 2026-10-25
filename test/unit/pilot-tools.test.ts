import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JsonValue, Observation } from '../../src/core/contracts.js';
import { createToolContext } from '../../src/core/tool-permissions.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { executeToolCall, type ToolCallAction } from '../../src/core/tool-runtime.js';
import { ToolError } from '../../src/core/tool.js';
import {
  createPilotToolRegistry,
  pilotAllowedSourcePaths,
  pilotToolNames,
} from '../../src/eval/pilot-tools.js';
import { preparePilotWorkspace, type PilotWorkspace } from '../../src/eval/pilot-workspace.js';

const repository = process.cwd();
let workspace: PilotWorkspace;
let registry: ToolRegistry;

const listDataSchema = z.strictObject({
  files: z.array(z.string()),
});
const searchDataSchema = z.strictObject({
  matches: z.array(
    z.strictObject({
      path: z.string(),
      line: z.number(),
      text: z.string(),
      lineTruncated: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
});
const readDataSchema = z.strictObject({
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  lines: z.array(z.strictObject({ line: z.number(), text: z.string() })),
  truncated: z.boolean(),
});

beforeAll(async () => {
  workspace = await preparePilotWorkspace(repository);
  registry = createPilotToolRegistry(workspace);
});

afterAll(async () => {
  if (workspace !== undefined) {
    const { rm } = await import('node:fs/promises');
    await rm(workspace.rootDirectory, { recursive: true, force: true });
  }
});

const inputs: Record<(typeof pilotToolNames)[number], JsonValue> = {
  'repo.list_files': {},
  'repo.search_source': { query: 'contextbudgeterror', caseSensitive: false },
  'repo.read_file_lines': {
    path: 'src/core/context-window.ts',
    startLine: 1,
    endLine: 4,
  },
};

function makeAction(
  toolName: (typeof pilotToolNames)[number],
  args: JsonValue = inputs[toolName],
): ToolCallAction {
  return {
    schemaVersion: 1,
    type: 'tool_call',
    callId: 'pilot-call',
    toolName,
    args,
  };
}

function invoke(
  toolName: (typeof pilotToolNames)[number],
  args: JsonValue = inputs[toolName],
  signal = new AbortController().signal,
  activeRegistry = registry,
) {
  return executeToolCall(makeAction(toolName, args), activeRegistry, {
    context: createToolContext({ scenarioId: 'repo-qa', signal }),
    enabledTools: [...pilotToolNames],
  });
}

function expectToolResult(observation: Observation): Extract<Observation, { type: 'tool_result' }> {
  if (observation.type !== 'tool_result') {
    throw new Error('Expected a successful tool result');
  }
  return observation;
}

function registryWithTimeout(timeoutMs: number): ToolRegistry {
  return new ToolRegistry(
    pilotToolNames.map((name) => ({
      ...registry.resolve(name, 'repo-qa', [name]),
      timeoutMs,
    })),
  );
}

describe('pilot read-only tool registration', () => {
  it('registers only the three read-only repo-qa tools', () => {
    for (const name of pilotToolNames) {
      expect(registry.resolve(name, 'repo-qa', [...pilotToolNames])).toMatchObject({
        name,
        schemaVersion: 1,
        sideEffect: 'none',
        allowedScenarios: ['repo-qa'],
        timeoutMs: 5_000,
      });
    }
    expect(registry.listAvailable('docs-qa', [...pilotToolNames])).toEqual([]);
  });

  it('lists exactly the five allowed files in the contract order', async () => {
    const observation = await invoke('repo.list_files');
    const result = expectToolResult(observation);

    expect(listDataSchema.parse(result.data).files).toEqual([...pilotAllowedSourcePaths]);
    expect(result.toolName).toBe('repo.list_files');
    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(2 * 1024);
  });

  it('describes optional and cross-field input constraints for model callers', () => {
    const descriptions = registry.describeAvailable('repo-qa', [...pilotToolNames]);
    const searchDescription = descriptions.find(({ name }) => name === 'repo.search_source');
    const readDescription = descriptions.find(({ name }) => name === 'repo.read_file_lines');

    expect(searchDescription?.inputSchema).toMatchObject({
      properties: {
        caseSensitive: {
          type: 'boolean',
          description: 'Defaults to false when omitted.',
        },
      },
    });
    expect(searchDescription?.inputSchema).not.toHaveProperty(
      'required',
      expect.arrayContaining(['caseSensitive']),
    );
    expect(readDescription?.inputSchema).toMatchObject({
      description:
        'Line numbers are 1-based and inclusive. endLine must be greater than or equal to startLine, and the requested range must contain at most 80 lines.',
    });
  });

  it('rejects unexpected list arguments through the input schema', async () => {
    const observation = await invoke('repo.list_files', { path: '../outside.txt' });

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'INPUT_INVALID',
    });
  });
});

describe('repo.search_source', () => {
  it('returns literal matches with stable paths and 1-based line numbers', async () => {
    const observation = await invoke('repo.search_source', {
      query: 'ContextBudgetError',
      caseSensitive: true,
    });

    expect(observation).toMatchObject({
      type: 'tool_result',
      toolName: 'repo.search_source',
      truncated: false,
    });
    const result = expectToolResult(observation);
    const data = searchDataSchema.parse(result.data);
    expect(data.matches.length).toBeGreaterThan(0);
    expect(
      data.matches.every(
        (match) =>
          new Set<string>(pilotAllowedSourcePaths).has(match.path) &&
          match.line > 0 &&
          match.text.includes('ContextBudgetError') &&
          [...match.text].length <= 240,
      ),
    ).toBe(true);
  });

  it('returns an empty successful result when nothing matches', async () => {
    const observation = await invoke('repo.search_source', {
      query: 'no-such-literal-in-the-pinned-sources-43157',
    });

    const result = expectToolResult(observation);
    expect(searchDataSchema.parse(result.data)).toEqual({
      matches: [],
      truncated: false,
    });
    expect(result).toMatchObject({
      type: 'tool_result',
      truncated: false,
    });
  });

  it('caps matches and marks the result and Observation as truncated', async () => {
    const observation = await invoke('repo.search_source', { query: 'e' });

    const result = expectToolResult(observation);
    expect(result.truncated).toBe(true);
    const data = searchDataSchema.parse(result.data);
    expect(data.matches).toHaveLength(20);
    expect(data.truncated).toBe(true);
    expect(data.matches.every((match) => [...match.text].length <= 240)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('rejects an empty search query', async () => {
    const observation = await invoke('repo.search_source', { query: '   ' });

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'INPUT_INVALID',
    });
  });
});

describe('repo.read_file_lines', () => {
  it('returns requested source lines with their absolute line numbers', async () => {
    const observation = await invoke('repo.read_file_lines', {
      path: 'src/core/context-window.ts',
      startLine: 1,
      endLine: 4,
    });

    const result = expectToolResult(observation);
    const data = readDataSchema.parse(result.data);
    expect(data.path).toBe('src/core/context-window.ts');
    expect(data.startLine).toBe(1);
    expect(data.endLine).toBe(4);
    expect(data.lines.map(({ line }) => line)).toEqual([1, 2, 3, 4]);
    expect(data.lines.every((line) => Buffer.byteLength(line.text, 'utf8') <= 512)).toBe(true);
    expect(data.truncated).toBe(false);
    expect(result).toMatchObject({
      type: 'tool_result',
      toolName: 'repo.read_file_lines',
      truncated: false,
    });
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('returns no rows beyond end-of-file without calling that a truncation', async () => {
    const observation = await invoke('repo.read_file_lines', {
      path: 'src/core/config.ts',
      startLine: 10_000,
      endLine: 10_010,
    });

    const result = expectToolResult(observation);
    expect(readDataSchema.parse(result.data)).toMatchObject({
      lines: [],
      truncated: false,
    });
    expect(result.truncated).toBe(false);
  });

  it.each([
    { path: 'src/core/context-window.ts', startLine: 1, endLine: 81 },
    { path: 'src/core/context-window.ts', startLine: 4, endLine: 3 },
    { path: '../outside.txt', startLine: 1, endLine: 2 },
    { path: 'C:\\outside.txt', startLine: 1, endLine: 2 },
  ])('rejects an invalid range or non-allowlisted path %#', async (args) => {
    const observation = await invoke('repo.read_file_lines', args);

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'INPUT_INVALID',
    });
  });
});

describe('pilot tool cancellation and timeouts', () => {
  it.each(pilotToolNames)('normalizes timeout for %s', async (toolName) => {
    const fastRegistry = registryWithTimeout(1);
    const observation = await invoke(toolName, inputs[toolName], undefined, fastRegistry);

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'TIMEOUT',
      message: 'The tool call timed out',
      retryable: true,
    });
  });

  it.each(pilotToolNames)('normalizes external cancellation for %s', async (toolName) => {
    const controller = new AbortController();
    const operation = invoke(toolName, inputs[toolName], controller.signal);
    await Promise.resolve();
    controller.abort('private-cancel-reason');
    const observation = await operation;

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
      retryable: true,
    });
    expect(JSON.stringify(observation)).not.toContain('private-cancel-reason');
  });

  it('never exposes a raw workspace error', () => {
    expect(new ToolError('EXECUTION_FAILED').message).toBe('The tool execution failed');
  });
});
