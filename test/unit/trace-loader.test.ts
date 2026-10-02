import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadStream } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFailure = vi.hoisted(() => ({ tracePath: '' }));

type NodeFsModule = {
  createReadStream(path: string, options: { encoding: 'utf8' }): ReadStream;
};

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<NodeFsModule>();
  return {
    ...original,
    createReadStream: (path: string, options: { encoding: 'utf8' }) =>
      original.createReadStream(path === readFailure.tracePath ? `${path}.missing` : path, options),
  };
});

import { experimentConfigSchema } from '../../src/core/config.js';
import { createArtifactRun } from '../../src/observability/artifact-run.js';
import { TraceIntegrityError, loadTraceRun } from '../../src/observability/trace-loader.js';
import { traceEventSchema } from '../../src/observability/trace-contracts.js';

const directories: string[] = [];
const createdAt = new Date('2026-09-21T10:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ directory: string; tracePath: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-loader-'));
  directories.push(root);
  const run = await createArtifactRun({
    directory: root,
    sessionId: 'session-1',
    config: experimentConfigSchema.parse({
      configId: 'baseline',
      scenarioId: 'repo-qa',
      model: { provider: 'fake', name: 'deterministic-model' },
    }),
    createdAt,
  });
  await run.trace.append(
    traceEventSchema.parse({
      schemaVersion: 1,
      eventId: 'event-0',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 0,
      eventType: 'session.started',
      timestamp: createdAt.toISOString(),
      payload: {
        configId: 'baseline',
        scenarioId: 'repo-qa',
        model: { provider: 'fake', name: 'deterministic-model' },
        inputMessage: 'Inspect the repository.',
      },
    }),
  );
  await run.trace.append(
    traceEventSchema.parse({
      schemaVersion: 1,
      eventId: 'event-1',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 1,
      eventType: 'session.completed',
      timestamp: createdAt.toISOString(),
      payload: { finalOutput: 'Done', turnCount: 0 },
    }),
  );
  await run.finalize({
    status: 'completed',
    completedAt: new Date('2026-09-21T10:00:01.000Z'),
    finalOutput: 'Done',
  });
  return {
    directory: run.paths.sessionDirectory,
    tracePath: run.paths.trace,
    manifestPath: run.paths.manifest,
  };
}

async function expectIntegrity(
  operation: () => Promise<unknown>,
  code: TraceIntegrityError['code'],
): Promise<TraceIntegrityError> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TraceIntegrityError);
  expect(thrown).toMatchObject({ code });
  return thrown as TraceIntegrityError;
}

async function replaceTrace(fixtureData: Awaited<ReturnType<typeof fixture>>, lines: unknown[]) {
  const content = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  await writeFile(fixtureData.tracePath, content, 'utf8');
  const manifest = JSON.parse(await readFile(fixtureData.manifestPath, 'utf8')) as {
    artifacts: { trace: { bytes: number; sha256: string } };
  };
  manifest.artifacts.trace.bytes = Buffer.byteLength(content);
  manifest.artifacts.trace.sha256 = createHash('sha256').update(content).digest('hex');
  await writeFile(fixtureData.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

async function replaceOutput(fixtureData: Awaited<ReturnType<typeof fixture>>, output: string) {
  const outputPath = join(fixtureData.directory, 'final-output.json');
  await writeFile(outputPath, output, 'utf8');
  const manifest = JSON.parse(await readFile(fixtureData.manifestPath, 'utf8')) as {
    artifacts: { finalOutput: { bytes: number; sha256: string } };
  };
  manifest.artifacts.finalOutput.bytes = Buffer.byteLength(output);
  manifest.artifacts.finalOutput.sha256 = createHash('sha256').update(output).digest('hex');
  await writeFile(fixtureData.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

function event(
  source: Record<string, unknown>,
  sequence: number,
  eventId: string,
  eventType: string,
  turnIndex: number | null,
  payload: unknown,
) {
  return { ...source, sequence, eventId, eventType, turnIndex, payload };
}

describe('loadTraceRun', () => {
  it('loads a valid manifest and streams a valid trace', async () => {
    const data = await fixture();

    const loaded = await loadTraceRun({ sessionDirectory: data.directory });

    expect(loaded.manifest.sessionId).toBe('session-1');
    expect(loaded.events.map((event) => event.eventType)).toEqual([
      'session.started',
      'session.completed',
    ]);
  });

  it('reports missing artifacts and invalid manifests without absolute paths', async () => {
    const data = await fixture();
    await rm(data.tracePath);
    const missing = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_ARTIFACT_MISSING',
    );
    expect(missing.path).toBe('trace.jsonl');

    await writeFile(data.manifestPath, '{"schemaVersion":2}\n', 'utf8');
    const invalid = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_MANIFEST_INVALID',
    );
    expect(String(invalid)).not.toContain(data.directory);

    await rm(data.manifestPath);
    const missingManifest = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_ARTIFACT_MISSING',
    );
    expect(missingManifest.path).toBe('run-manifest.json');
  });

  it('detects hash and byte mismatches before parsing events', async () => {
    const data = await fixture();
    await writeFile(data.tracePath, 'tampered\n', 'utf8');

    await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_HASH_MISMATCH',
    );
  });

  it('detects malformed JSON and blank truncated lines', async () => {
    const data = await fixture();
    await replaceTrace(data, [{ malformed: true }, '']);

    const malformed = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_EVENT_INVALID',
    );
    expect(malformed.line).toBe(1);

    await replaceTrace(data, [JSON.parse('{"schemaVersion":1}')]);
    await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_EVENT_INVALID',
    );
  });

  it('normalizes trace stream read errors without exposing system paths', async () => {
    const data = await fixture();
    readFailure.tracePath = data.tracePath;
    try {
      const error = await expectIntegrity(
        () => loadTraceRun({ sessionDirectory: data.directory }),
        'TRACE_ARTIFACT_MISSING',
      );
      expect(error.path).toBe('trace.jsonl');
      expect(String(error)).not.toContain(data.directory);
      expect(String(error)).not.toContain('.missing');
    } finally {
      readFailure.tracePath = '';
    }
  });

  it('detects missing, malformed, and sensitive final output artifacts', async () => {
    const data = await fixture();
    const outputPath = join(data.directory, 'final-output.json');
    await rm(outputPath);
    const missing = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_ARTIFACT_MISSING',
    );
    expect(missing.path).toBe('final-output.json');

    await replaceOutput(data, '{"broken":\n');
    const malformed = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_JSONL_TRUNCATED',
    );
    expect(malformed.path).toBe('final-output.json');

    await replaceOutput(data, '{"apiKey":"pseudo-secret"}\n');
    const sensitive = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_EVENT_INVALID',
    );
    expect(sensitive.path).toBe('final-output.json');
    expect(String(sensitive)).not.toContain('pseudo-secret');
  });

  it.each([
    ['sequence', { sequence: 4 }, 'TRACE_SEQUENCE_INVALID'],
    ['session', { sessionId: 'session-2' }, 'TRACE_SESSION_MISMATCH'],
    ['duplicate event ID', { eventId: 'event-0' }, 'TRACE_EVENT_ID_DUPLICATE'],
  ] as const)('detects %s corruption at the first bad line', async (_name, patch, code) => {
    const data = await fixture();
    const started = JSON.parse((await readFile(data.tracePath, 'utf8')).split('\n')[0]!) as Record<
      string,
      unknown
    >;
    const completed = {
      ...started,
      sequence: 1,
      eventId: 'event-1',
      eventType: 'session.completed',
      payload: { finalOutput: 'Done', turnCount: 0 },
      ...patch,
    };
    await replaceTrace(data, [started, completed]);

    const error = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      code,
    );
    expect(error.line).toBe(2);
  });

  it('detects events after a terminal event', async () => {
    const data = await fixture();
    const lines = (await readFile(data.tracePath, 'utf8')).trimEnd().split('\n');
    const started = JSON.parse(lines[0]!) as Record<string, unknown>;
    const completed = JSON.parse(lines[1]!) as Record<string, unknown>;
    const afterTerminal = {
      ...started,
      eventId: 'event-2',
      sequence: 2,
      turnIndex: 0,
      eventType: 'context.built',
      payload: {
        context: {
          schemaVersion: 1,
          systemRules: ['Return one action.'],
          taskInput: 'Inspect the repository.',
          recentTurns: [],
          observations: [],
          omittedTurnCount: 0,
          omittedObservationCount: 0,
        },
      },
    };
    await replaceTrace(data, [started, completed, afterTerminal]);

    const error = await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_TERMINAL_INVALID',
    );
    expect(error.line).toBe(3);
  });

  it('detects invalid model and tool pairing and terminal truncation', async () => {
    const data = await fixture();
    const started = JSON.parse((await readFile(data.tracePath, 'utf8')).split('\n')[0]!) as Record<
      string,
      unknown
    >;
    const requested = {
      ...started,
      sequence: 1,
      eventId: 'event-1',
      turnIndex: 0,
      eventType: 'model.responded',
      payload: { response: { schemaVersion: 1, output: 'Done' } },
    };
    await replaceTrace(data, [started, requested]);

    await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_PAIRING_INVALID',
    );

    await replaceTrace(data, [started]);
    await expectIntegrity(
      () => loadTraceRun({ sessionDirectory: data.directory }),
      'TRACE_PAIRING_INVALID',
    );
  });

  it('accepts complete model and tool request/response pairings', async () => {
    const data = await fixture();
    const started = JSON.parse((await readFile(data.tracePath, 'utf8')).split('\n')[0]!) as Record<
      string,
      unknown
    >;
    const finalAction = {
      schemaVersion: 1,
      type: 'final_answer',
      content: 'Done',
    };
    const request = event(started, 1, 'event-1', 'model.requested', 0, {
      request: {
        schemaVersion: 1,
        sessionId: 'session-1',
        turnIndex: 0,
        inputMessage: 'Inspect the repository.',
        model: {
          provider: 'fake',
          name: 'deterministic-model',
          temperature: 0,
          maxOutputTokens: 1024,
        },
      },
    });
    const response = event(started, 2, 'event-2', 'model.responded', 0, {
      response: { schemaVersion: 1, output: finalAction },
    });
    const turn = event(started, 3, 'event-3', 'turn.completed', 0, {
      turn: {
        schemaVersion: 1,
        sessionId: 'session-1',
        turnIndex: 0,
        inputMessage: 'Inspect the repository.',
        modelResponse: finalAction,
        action: finalAction,
        observations: [],
        stopReason: 'FINAL_ANSWER',
      },
    });
    const completed = event(started, 4, 'event-4', 'session.completed', null, {
      finalOutput: 'Done',
      turnCount: 1,
    });
    await replaceTrace(data, [started, request, response, turn, completed]);

    const loaded = await loadTraceRun({ sessionDirectory: data.directory });
    expect(loaded.events.map((traceEvent) => traceEvent.eventType)).toEqual([
      'session.started',
      'model.requested',
      'model.responded',
      'turn.completed',
      'session.completed',
    ]);
  });

  it.each([
    [
      'duplicate session start',
      'session.started',
      null,
      {
        configId: 'baseline',
        scenarioId: 'repo-qa',
        model: { provider: 'fake', name: 'deterministic-model' },
        inputMessage: 'Inspect the repository.',
      },
    ],
    [
      'tool completion without request',
      'tool.completed',
      0,
      {
        callId: 'call-1',
        toolName: 'repository.search',
        data: {},
        truncated: false,
        durationMs: 0,
      },
    ],
  ] as const)(
    'rejects %s at its first invalid line',
    async (_name, eventType, turnIndex, payload) => {
      const data = await fixture();
      const started = JSON.parse(
        (await readFile(data.tracePath, 'utf8')).split('\n')[0]!,
      ) as Record<string, unknown>;
      const invalid = event(started, 1, 'event-1', eventType, turnIndex, payload);
      await replaceTrace(data, [started, invalid]);

      const error = await expectIntegrity(
        () => loadTraceRun({ sessionDirectory: data.directory }),
        'TRACE_PAIRING_INVALID',
      );
      expect(error.line).toBe(2);
    },
  );
});
