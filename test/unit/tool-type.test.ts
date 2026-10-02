import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { JsonValue } from '../../src/core/contracts.js';
import { createToolContext } from '../../src/core/tool-permissions.js';
import type {
  ToolContext,
  ToolDefinition,
  ToolDefinitionMetadata,
  ToolErrorCode,
} from '../../src/core/tool.js';

type SearchInput = {
  query: string;
};

type SearchOutput = {
  matches: string[];
};

it('defines an asynchronous schema-first tool contract', async () => {
  const controller = new AbortController();
  const definition: ToolDefinition<SearchInput, SearchOutput> = {
    schemaVersion: 1,
    name: 'repository.search',
    description: 'Search repository content',
    inputSchema: z.strictObject({ query: z.string().min(1) }),
    outputSchema: z.strictObject({ matches: z.array(z.string()) }),
    timeoutMs: 1_000,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute(input, context) {
      expect(context.scenarioId).toBe('repo-qa');
      expect(context.signal).toBe(controller.signal);
      expect(context.workspace?.rootDirectory).toBe('E:\\workspace');
      return Promise.resolve({ matches: [input.query] });
    },
  };
  const context: ToolContext = createToolContext({
    scenarioId: 'repo-qa',
    signal: controller.signal,
    workspaceRoot: 'E:\\workspace',
  });

  expectTypeOf(definition).toMatchTypeOf<ToolDefinitionMetadata>();
  expectTypeOf(definition.execute).returns.toEqualTypeOf<Promise<SearchOutput>>();
  const result = await definition.execute({ query: 'runtime' }, context);
  const jsonOutput: JsonValue = result;

  expect(jsonOutput).toEqual({
    matches: ['runtime'],
  });
});

it('keeps tool metadata and error codes narrow', () => {
  expectTypeOf<ToolDefinitionMetadata['schemaVersion']>().toEqualTypeOf<1>();
  expectTypeOf<ToolDefinitionMetadata['sideEffect']>().toEqualTypeOf<
    'none' | 'local_write' | 'external'
  >();
  expectTypeOf<ToolErrorCode>().toEqualTypeOf<
    | 'TOOL_NOT_FOUND'
    | 'INPUT_INVALID'
    | 'PERMISSION_DENIED'
    | 'TIMEOUT'
    | 'EXECUTION_FAILED'
    | 'OUTPUT_INVALID'
  >();
});

it('requires tool outputs to be JSON-safe at the type boundary', () => {
  // @ts-expect-error Date is not a valid JsonValue.
  const invalidDefinition: ToolDefinition<Record<string, never>, { createdAt: Date }> = undefined;

  expect(invalidDefinition).toBeUndefined();
});
