import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { z } from 'zod';

import {
  FakeModelAdapter,
  TraceIntegrityError,
  TraceRecorder,
  ToolRegistry,
  createArtifactRun,
  createSqliteRunIndex,
  loadTraceRun,
  replayTraceRun,
  runAgent,
} from '../dist/index.js';

const createdAt = new Date('2026-09-25T10:00:00.000Z');
const root = await mkdtemp(join(tmpdir(), 'mypiiii-trace-'));
const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });

function createInput(sessionId, tools = []) {
  return {
    schemaVersion: 1,
    sessionId,
    inputMessage: 'Return the integration result.',
    config: {
      schemaVersion: 1,
      configId: 'trace-integration',
      scenarioId: 'repo-qa',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
        temperature: 0,
        maxOutputTokens: 128,
      },
      runtime: { maxTurns: 3, timeoutMs: 1_000 },
      tools: { enabled: tools },
      artifacts: { directory: root },
    },
  };
}

const answer = (content) => ({
  schemaVersion: 1,
  type: 'final_answer',
  content,
});

const toolCall = (callId = 'call-1') => ({
  schemaVersion: 1,
  type: 'tool_call',
  callId,
  toolName: 'repository.search',
  args: { query: 'runtime', token: 'pseudo-secret' },
});

function searchTool(execute) {
  return {
    schemaVersion: 1,
    name: 'repository.search',
    description: 'Search repository content',
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: z.strictObject({ matches: z.array(z.string()) }),
    timeoutMs: 100,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    execute,
  };
}

async function runScenario(sessionId, input, adapter, registry) {
  const artifact = await createArtifactRun({
    directory: root,
    sessionId,
    config: input.config,
    createdAt,
  });
  const recorder = new TraceRecorder({
    sessionId,
    sink: artifact.trace,
    now: () => createdAt,
  });
  const result = await runAgent(input, adapter, {
    trace: { recorder },
    ...(registry === undefined ? {} : { tools: { registry } }),
  });
  const finalOutput = result.status === 'completed' ? result.finalOutput : { error: result.error };
  const manifest = await artifact.finalize({
    status: result.status,
    completedAt: new Date(createdAt.getTime() + 1_000),
    finalOutput,
  });
  const sessionDirectory = artifact.paths.sessionDirectory;
  const loaded = await loadTraceRun({ sessionDirectory });
  const replay = await replayTraceRun({ sessionDirectory });

  const artifactPath = (path) => relative(root, join(sessionDirectory, path)).replaceAll('\\', '/');
  index.createRun({
    schemaVersion: 1,
    sessionId,
    configId: input.config.configId,
    scenarioId: input.config.scenarioId,
    model: {
      provider: input.config.model.provider,
      name: input.config.model.name,
    },
    createdAt: manifest.createdAt,
    artifacts: {
      manifest: artifactPath('run-manifest.json'),
      trace: artifactPath('trace.jsonl'),
      finalOutput: artifactPath('final-output.json'),
    },
  });
  const indexed = index.finishRun({
    schemaVersion: 1,
    sessionId,
    status: result.status,
    completedAt: manifest.completedAt,
  });

  const sequences = loaded.events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, sequence) => sequence),
  );
  assert.equal(replay.status, result.status);
  assert.deepEqual(
    replay.finalOutput,
    result.status === 'completed' ? result.finalOutput : undefined,
  );
  assert.equal(indexed.status, result.status);
  return { artifact, result, loaded, replay, sessionDirectory };
}

try {
  const completed = await runScenario(
    'trace-success',
    createInput('trace-success'),
    new FakeModelAdapter([
      { type: 'response', response: { schemaVersion: 1, output: answer('ok') } },
    ]),
  );
  assert.deepEqual(
    completed.loaded.events.map((event) => event.eventType),
    [
      'session.started',
      'model.requested',
      'model.responded',
      'turn.completed',
      'session.completed',
    ],
  );

  const registry = new ToolRegistry([searchTool(async () => ({ matches: ['runtime'] }))]);
  const toolSuccess = await runScenario(
    'trace-tool-success',
    createInput('trace-tool-success', ['repository.search']),
    new FakeModelAdapter([
      { type: 'response', response: { schemaVersion: 1, output: toolCall() } },
      { type: 'response', response: { schemaVersion: 1, output: answer('tool-ok') } },
    ]),
    registry,
  );
  assert.equal(
    toolSuccess.loaded.events.some((event) => event.eventType === 'tool.completed'),
    true,
  );

  const failingRegistry = new ToolRegistry([
    searchTool(async () => {
      throw new Error('authorization=pseudo-secret');
    }),
  ]);
  const toolFailure = await runScenario(
    'trace-tool-failure',
    createInput('trace-tool-failure', ['repository.search']),
    new FakeModelAdapter([
      { type: 'response', response: { schemaVersion: 1, output: toolCall('call-2') } },
      { type: 'response', response: { schemaVersion: 1, output: answer('recovered') } },
    ]),
    failingRegistry,
  );
  assert.equal(
    toolFailure.loaded.events.some((event) => event.eventType === 'tool.failed'),
    true,
  );

  const runtimeFailure = await runScenario(
    'trace-runtime-failure',
    createInput('trace-runtime-failure'),
    new FakeModelAdapter([{ type: 'error', cause: new Error('api-key=pseudo-secret') }]),
  );
  assert.equal(runtimeFailure.result.status, 'failed');
  assert.equal(runtimeFailure.replay.failure?.code, 'MODEL_CALL_FAILED');

  const tracePath = completed.artifact.paths.trace;
  const manifestPath = completed.artifact.paths.manifest;
  const outputPath = completed.artifact.paths.finalOutput;
  const originalTrace = await readFile(tracePath);
  const originalManifest = await readFile(manifestPath);
  const originalOutput = await readFile(outputPath);
  await writeFile(tracePath, Buffer.concat([originalTrace, Buffer.from('corruption\\n')]));
  await assert.rejects(
    loadTraceRun({ sessionDirectory: completed.sessionDirectory }),
    (error) => error instanceof TraceIntegrityError && error.code === 'TRACE_HASH_MISMATCH',
  );
  await writeFile(tracePath, originalTrace);
  await writeFile(manifestPath, Buffer.from('{"broken":true}\n'));
  await assert.rejects(
    loadTraceRun({ sessionDirectory: completed.sessionDirectory }),
    (error) => error instanceof TraceIntegrityError && error.code === 'TRACE_MANIFEST_INVALID',
  );
  await writeFile(manifestPath, originalManifest);
  await writeFile(outputPath, Buffer.from('{"tampered":true}\n'));
  await assert.rejects(
    loadTraceRun({ sessionDirectory: completed.sessionDirectory }),
    (error) => error instanceof TraceIntegrityError && error.code === 'TRACE_HASH_MISMATCH',
  );
  await writeFile(outputPath, originalOutput);
  assert.equal(
    JSON.stringify(await readFile(completed.artifact.paths.trace)),
    JSON.stringify(originalTrace),
  );
  assert.equal(
    JSON.stringify(await readFile(toolSuccess.artifact.paths.trace)).includes('pseudo-secret'),
    false,
  );
  assert.equal(
    JSON.stringify(await readFile(toolFailure.artifact.paths.trace)).includes('pseudo-secret'),
    false,
  );

  index.close();
  console.log('Trace integration test passed.');
} finally {
  try {
    index.close();
  } catch {
    // The assertion output is more useful than a repeated close error.
  }
  await rm(root, { recursive: true, force: true });
}
