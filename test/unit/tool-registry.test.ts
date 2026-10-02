import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { JsonValue } from '../../src/core/contracts.js';
import {
  ToolRegistry,
  ToolRegistryError,
  toolDescriptionSchema,
} from '../../src/core/tool-registry.js';
import { ToolError, type ToolDefinition } from '../../src/core/tool.js';

type SearchInput = { query: string };
type SearchOutput = { matches: string[] };
type SummaryInput = { section: string };
type SummaryOutput = { summary: string };

function createTools() {
  const searchExecute = vi.fn<(input: SearchInput) => Promise<SearchOutput>>((input) =>
    Promise.resolve({ matches: [input.query] }),
  );
  const summaryExecute = vi.fn<(input: SummaryInput) => Promise<SummaryOutput>>((input) =>
    Promise.resolve({ summary: input.section }),
  );

  const search: ToolDefinition<SearchInput, SearchOutput> = {
    schemaVersion: 1,
    name: 'repository.search',
    description: 'Search repository content',
    inputSchema: z.strictObject({ query: z.string().min(1) }),
    outputSchema: z.strictObject({ matches: z.array(z.string()) }),
    timeoutMs: 1_000,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute: searchExecute,
  };
  const summary: ToolDefinition<SummaryInput, SummaryOutput> = {
    schemaVersion: 1,
    name: 'project.summary',
    description: 'Read a project section summary',
    inputSchema: z.strictObject({ section: z.string().min(1) }),
    outputSchema: z.strictObject({ summary: z.string() }),
    timeoutMs: 1_000,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa', 'docs-qa'],
    execute: summaryExecute,
  };

  return { search, searchExecute, summary, summaryExecute };
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to throw');
}

describe('ToolRegistry registration', () => {
  it('registers two deterministic read-only tools at construction', () => {
    const { search, searchExecute, summary, summaryExecute } = createTools();
    const registry = new ToolRegistry([search, summary]);

    expect(registry.listAvailable('repo-qa', ['repository.search', 'project.summary'])).toEqual([
      expect.objectContaining({ name: 'project.summary', sideEffect: 'none' }),
      expect.objectContaining({ name: 'repository.search', sideEffect: 'none' }),
    ]);
    expect(searchExecute).not.toHaveBeenCalled();
    expect(summaryExecute).not.toHaveBeenCalled();
  });

  it('rejects duplicate names without exposing the conflicting definition', () => {
    const { search } = createTools();
    const error = captureError(() => new ToolRegistry([search, search]));

    expect(error).toBeInstanceOf(ToolRegistryError);
    expect(error).toMatchObject({
      code: 'TOOL_NAME_CONFLICT',
      message: 'A tool with this name is already registered',
    });
  });

  it('rejects invalid metadata during construction', () => {
    const { search } = createTools();
    const invalid = {
      ...search,
      timeoutMs: 0,
    } as ToolDefinition<unknown, JsonValue>;
    const error = captureError(() => new ToolRegistry([invalid]));

    expect(error).toBeInstanceOf(ToolRegistryError);
    expect(error).toMatchObject({
      code: 'TOOL_DEFINITION_INVALID',
      message: 'The tool definition is invalid',
    });
  });
});

describe('ToolRegistry availability', () => {
  it('intersects registered tools, enabled tools, and the scenario allowlist', () => {
    const { search, summary } = createTools();
    const registry = new ToolRegistry([search, summary]);

    expect(registry.listAvailable('docs-qa', ['repository.search', 'project.summary'])).toEqual([
      expect.objectContaining({ name: 'project.summary' }),
    ]);
    expect(registry.listAvailable('repo-qa', ['repository.search'])).toEqual([
      expect.objectContaining({ name: 'repository.search' }),
    ]);
    expect(registry.listAvailable('repo-qa', [])).toEqual([]);
  });

  it('resolves only enabled tools allowed in the active scenario', () => {
    const { search, summary } = createTools();
    const registry = new ToolRegistry([search, summary]);

    expect(registry.resolve('repository.search', 'repo-qa', ['repository.search'])).toMatchObject({
      name: 'repository.search',
    });
    const missing = captureError(() =>
      registry.resolve('missing.tool', 'repo-qa', ['missing.tool']),
    );
    const disabled = captureError(() => registry.resolve('repository.search', 'repo-qa', []));
    const disallowed = captureError(() =>
      registry.resolve('repository.search', 'docs-qa', ['repository.search']),
    );

    expect(missing).toBeInstanceOf(ToolError);
    expect(missing).toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(disabled).toBeInstanceOf(ToolError);
    expect(disabled).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(disallowed).toBeInstanceOf(ToolError);
    expect(disallowed).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('produces stable model descriptions without execution functions or internal metadata', () => {
    const { search, searchExecute, summaryExecute } = createTools();
    const registry = new ToolRegistry([search]);

    const descriptions = registry.describeAvailable('repo-qa', ['repository.search']);

    expect(descriptions).toHaveLength(1);
    expect(toolDescriptionSchema.safeParse(descriptions[0]).success).toBe(true);
    expect(descriptions[0]).toMatchObject({
      schemaVersion: 1,
      name: 'repository.search',
      description: 'Search repository content',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(descriptions)).not.toContain('execute');
    expect(JSON.stringify(descriptions)).not.toContain('allowedScenarios');
    expect(searchExecute).not.toHaveBeenCalled();
    expect(summaryExecute).not.toHaveBeenCalled();
  });
});
