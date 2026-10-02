import assert from 'node:assert/strict';

import { FakeModelAdapter, runAgent, runtimeResultSchema } from '../dist/index.js';

function createInput(runtime = { maxTurns: 3, timeoutMs: 1_000 }) {
  return {
    schemaVersion: 1,
    sessionId: 'integration-session',
    inputMessage: 'Return the integration result.',
    config: {
      schemaVersion: 1,
      configId: 'runtime-integration',
      scenarioId: 'repo-qa',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
        temperature: 0,
        maxOutputTokens: 128,
      },
      runtime,
      tools: { enabled: [] },
      artifacts: { directory: './artifacts' },
    },
  };
}

const finalResponse = {
  schemaVersion: 1,
  output: {
    schemaVersion: 1,
    type: 'final_answer',
    content: { result: 'integration-ok' },
  },
};

const completed = await runAgent(
  createInput(),
  new FakeModelAdapter([{ type: 'response', response: finalResponse }]),
);
assert.equal(completed.status, 'completed');
assert.deepEqual(completed.finalOutput, { result: 'integration-ok' });
assert.equal(runtimeResultSchema.safeParse(completed).success, true);

const invalidResponse = {
  schemaVersion: 1,
  output: { invalid: 'action' },
};
const invalid = await runAgent(
  createInput(),
  new FakeModelAdapter([
    { type: 'response', response: invalidResponse },
    { type: 'response', response: invalidResponse },
  ]),
);
assert.equal(invalid.status, 'failed');
assert.equal(invalid.error.code, 'MODEL_OUTPUT_INVALID');

const maxTurns = await runAgent(
  createInput({ maxTurns: 1, timeoutMs: 1_000 }),
  new FakeModelAdapter([{ type: 'response', response: invalidResponse }]),
);
assert.equal(maxTurns.status, 'failed');
assert.equal(maxTurns.error.code, 'MAX_TURNS_EXCEEDED');

const timedOut = await runAgent(
  createInput({ maxTurns: 3, timeoutMs: 5 }),
  new FakeModelAdapter([{ type: 'wait_for_abort' }]),
);
assert.equal(timedOut.status, 'failed');
assert.equal(timedOut.error.code, 'RUN_TIMEOUT');

console.log('Runtime integration test passed.');
