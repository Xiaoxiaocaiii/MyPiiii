import assert from 'node:assert/strict';

import { z } from 'zod';

import { FakeModelAdapter, ToolRegistry, runAgent, runtimeResultSchema } from '../dist/index.js';

const scenarioId = 'repo-qa';

function createInput(enabled, context) {
  return {
    schemaVersion: 1,
    sessionId: 'tool-context-integration',
    inputMessage: 'Inspect the runtime with deterministic tools.',
    config: {
      schemaVersion: 1,
      configId: 'tool-context-integration',
      scenarioId,
      model: {
        provider: 'fake',
        name: 'deterministic-model',
        temperature: 0,
        maxOutputTokens: 128,
      },
      runtime: {
        maxTurns: 4,
        timeoutMs: 2_000,
      },
      ...(context === undefined ? {} : { context }),
      tools: { enabled },
      artifacts: { directory: './artifacts' },
    },
  };
}

function toolCall(callId, toolName, args) {
  return {
    schemaVersion: 1,
    type: 'tool_call',
    callId,
    toolName,
    args,
  };
}

function response(output) {
  return {
    type: 'response',
    response: {
      schemaVersion: 1,
      output,
    },
  };
}

function finalAnswer(content = 'integration-complete') {
  return {
    schemaVersion: 1,
    type: 'final_answer',
    content,
  };
}

function defineTool({
  name,
  inputSchema,
  outputSchema,
  execute,
  timeoutMs = 100,
  sideEffect = 'none',
}) {
  return {
    schemaVersion: 1,
    name,
    description: `Deterministic integration tool: ${name}`,
    inputSchema,
    outputSchema,
    timeoutMs,
    sideEffect,
    allowedScenarios: [scenarioId],
    execute,
  };
}

const searchTool = defineTool({
  name: 'repository.search',
  inputSchema: z.strictObject({ query: z.string().trim().min(1) }),
  outputSchema: z.strictObject({ matches: z.array(z.string().trim()) }),
  execute: async ({ query }) => ({
    matches: [` src/core/${query}.ts `],
  }),
});

const readTool = defineTool({
  name: 'repository.read',
  inputSchema: z.strictObject({ path: z.string().trim().min(1) }),
  outputSchema: z.strictObject({ content: z.string().trim() }),
  execute: async ({ path }) => ({
    content: ` deterministic content from ${path} `,
  }),
});

const permissionTool = defineTool({
  name: 'external.lookup',
  inputSchema: z.strictObject({ key: z.string() }),
  outputSchema: z.strictObject({ value: z.string() }),
  sideEffect: 'external',
  execute: async ({ key }) => ({ value: key }),
});

const timeoutTool = defineTool({
  name: 'repository.wait',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ value: z.string() }),
  timeoutMs: 5,
  execute: async (_input, context) =>
    new Promise((_, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('timeout-private-detail')), {
        once: true,
      });
    }),
});

const failingTool = defineTool({
  name: 'repository.fail',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ value: z.string() }),
  execute: async () => {
    throw new Error('credential=execution-private-detail');
  },
});

const invalidOutputTool = defineTool({
  name: 'repository.invalid-output',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ value: z.string() }),
  execute: async () => ({
    unexpected: 'unvalidated-private-output',
  }),
});

const largeOutputTool = defineTool({
  name: 'repository.large',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ content: z.string() }),
  execute: async () => ({
    content: 'x'.repeat(200),
  }),
});

const registry = new ToolRegistry([
  searchTool,
  readTool,
  permissionTool,
  timeoutTool,
  failingTool,
  invalidOutputTool,
  largeOutputTool,
]);

const successfulAdapter = new FakeModelAdapter([
  response(toolCall('search-1', 'repository.search', { query: ' runtime ' })),
  response(toolCall('read-1', 'repository.read', { path: ' src/core/runtime.ts ' })),
  response(finalAnswer()),
]);
const successful = await runAgent(
  createInput(['repository.search', 'repository.read']),
  successfulAdapter,
  { tools: { registry } },
);

assert.equal(successful.status, 'completed');
assert.equal(successful.finalOutput, 'integration-complete');
assert.equal(runtimeResultSchema.safeParse(successful).success, true);
assert.equal(successful.turns.length, 3);
assert.deepEqual(successful.turns[0].observations[0].data, {
  matches: ['src/core/runtime.ts'],
});
assert.deepEqual(successful.turns[1].observations[0].data, {
  content: 'deterministic content from src/core/runtime.ts',
});
assert.equal(successfulAdapter.requests[1].context.observations.length, 1);
assert.equal(successfulAdapter.requests[2].context.observations.length, 2);
assert.deepEqual(successful.turns[0].action.args, { redacted: true });
assert.deepEqual(successful.turns[1].action.args, { redacted: true });

async function expectToolError({
  toolName,
  args,
  code,
  forbidden = [],
  activeRegistry = registry,
}) {
  const adapter = new FakeModelAdapter([
    response(toolCall(`call-${code.toLowerCase()}`, toolName, args)),
    response(finalAnswer(`recovered-${code}`)),
  ]);
  const result = await runAgent(createInput([toolName]), adapter, {
    tools: { registry: activeRegistry },
  });

  assert.equal(result.status, 'completed');
  assert.equal(runtimeResultSchema.safeParse(result).success, true);
  assert.equal(result.turns[0].observations[0].type, 'tool_error');
  assert.equal(result.turns[0].observations[0].code, code);
  assert.equal(adapter.requests[1].context.observations[0].observation.code, code);

  const publicResult = JSON.stringify(result);
  const nextRequest = JSON.stringify(adapter.requests[1]);
  for (const secret of forbidden) {
    assert.equal(publicResult.includes(secret), false);
    assert.equal(nextRequest.includes(secret), false);
  }
}

await expectToolError({
  toolName: 'missing.tool',
  args: {},
  code: 'TOOL_NOT_FOUND',
});

await expectToolError({
  toolName: 'repository.search',
  args: { query: 42, secret: 'sensitive-invalid-argument' },
  code: 'INPUT_INVALID',
  forbidden: ['sensitive-invalid-argument'],
});

await expectToolError({
  toolName: 'external.lookup',
  args: { key: 'public-key' },
  code: 'PERMISSION_DENIED',
});

await expectToolError({
  toolName: 'repository.wait',
  args: {},
  code: 'TIMEOUT',
  forbidden: ['timeout-private-detail'],
});

await expectToolError({
  toolName: 'repository.fail',
  args: {},
  code: 'EXECUTION_FAILED',
  forbidden: ['execution-private-detail', 'credential'],
});

await expectToolError({
  toolName: 'repository.invalid-output',
  args: {},
  code: 'OUTPUT_INVALID',
  forbidden: ['unvalidated-private-output', 'unexpected'],
});

const truncationAdapter = new FakeModelAdapter([
  response(toolCall('large-1', 'repository.large', {})),
  response(finalAnswer()),
]);
const truncated = await runAgent(
  createInput(['repository.large'], {
    maxCharacters: 4_000,
    recentTurns: 4,
    observationMaxCharacters: 24,
  }),
  truncationAdapter,
  { tools: { registry } },
);

assert.equal(truncated.status, 'completed');
const truncatedEntry = truncationAdapter.requests[1].context.observations[0];
assert.equal(truncatedEntry.sourceTurnIndex, 0);
assert.equal(truncatedEntry.toolName, 'repository.large');
assert.equal(truncatedEntry.callId, 'large-1');
assert.equal(truncatedEntry.truncated, true);
assert.equal(truncatedEntry.observation.truncated, true);
assert.equal(typeof truncatedEntry.observation.data, 'string');
assert.equal(truncatedEntry.observation.data.length, 24);

const budgetAdapter = new FakeModelAdapter([response(finalAnswer('must-not-run'))]);
const budgetFailure = await runAgent(
  createInput([], {
    maxCharacters: 1,
    recentTurns: 4,
    observationMaxCharacters: 2_000,
  }),
  budgetAdapter,
);

assert.equal(budgetFailure.status, 'failed');
assert.equal(budgetFailure.error.code, 'CONTEXT_BUDGET_EXCEEDED');
assert.equal(budgetAdapter.requests.length, 0);

console.log('Tool Runtime and context integration test passed.');
