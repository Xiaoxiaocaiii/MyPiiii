import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fileFailures = vi.hoisted(() => ({
  openPath: '',
  renameTarget: '',
  closePath: '',
  removePath: '',
  removeFailures: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const path = String(args[0]);
      if (fileFailures.openPath !== '' && path.includes(fileFailures.openPath)) {
        throw new Error('private open path');
      }

      const handle = await original.open(...args);
      if (fileFailures.closePath !== path) {
        return handle;
      }

      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              await target.close();
              fileFailures.closePath = '';
              throw new Error('private close path');
            };
          }
          if (property === 'write') {
            return (...writeArgs: Parameters<typeof target.write>) => target.write(...writeArgs);
          }
          if (property === 'sync') {
            return () => target.sync();
          }
          return Reflect.get(target, property, target) as unknown;
        },
      });
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (fileFailures.renameTarget === String(args[1])) {
        throw new Error('private rename path');
      }
      return original.rename(...args);
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (
        fileFailures.removeFailures > 0 &&
        fileFailures.removePath !== '' &&
        String(args[0]).includes(fileFailures.removePath)
      ) {
        fileFailures.removeFailures -= 1;
        throw new Error('private cleanup path');
      }
      return original.rm(...args);
    },
  };
});

import { experimentConfigSchema, type ExperimentConfig } from '../../src/core/config.js';
import {
  ArtifactRunError,
  artifactFailureMarkerSchema,
  createArtifactRun,
} from '../../src/observability/artifact-run.js';
import { traceEventSchema } from '../../src/observability/trace-contracts.js';

const temporaryDirectories: string[] = [];
const createdAt = new Date('2026-09-21T10:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fsPromises.rm(directory, { recursive: true, force: true })),
  );
  fileFailures.openPath = '';
  fileFailures.renameTarget = '';
  fileFailures.closePath = '';
  fileFailures.removePath = '';
  fileFailures.removeFailures = 0;
});

async function temporaryRoot(): Promise<string> {
  const directory = await fsPromises.mkdtemp(join(tmpdir(), 'agent-harness-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

function config(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return experimentConfigSchema.parse({
    configId: 'baseline',
    scenarioId: 'repo-qa',
    model: {
      provider: 'fake',
      name: 'deterministic-model',
    },
    ...overrides,
  });
}

function startedEvent() {
  return traceEventSchema.parse({
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
  });
}

function completedEvent() {
  return traceEventSchema.parse({
    schemaVersion: 1,
    eventId: 'event-1',
    sessionId: 'session-1',
    turnIndex: null,
    sequence: 1,
    eventType: 'session.completed',
    timestamp: createdAt.toISOString(),
    payload: {
      finalOutput: 'Done',
      turnCount: 0,
    },
  });
}

async function expectArtifactError(
  operation: () => Promise<unknown>,
  code: ArtifactRunError['code'],
): Promise<void> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ArtifactRunError);
  expect(thrown).toMatchObject({ code });
}

describe('artifact run layout and publication', () => {
  it('creates a dated exclusive session directory and publishes hashed artifacts', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });

    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());
    const manifest = await run.finalize({
      status: 'completed',
      completedAt: new Date('2026-09-21T10:00:01.000Z'),
      finalOutput: { answer: 'Done' },
    });

    expect(run.paths.sessionDirectory).toContain('2026-09-21');
    expect(manifest.artifacts.trace.path).toBe('trace.jsonl');
    expect(manifest.artifacts.finalOutput.path).toBe('final-output.json');
    expect(manifest.artifacts.trace.bytes).toBeGreaterThan(0);
    expect(manifest.artifacts.trace.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await fsPromises.stat(run.paths.manifest)).toBeTruthy();
    await expect(fsPromises.readFile(run.paths.failure, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not create P5 metric artifacts and publishes manifest last', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());

    await run.finalize({
      status: 'failed',
      completedAt: new Date('2026-09-21T10:00:01.000Z'),
      finalOutput: { error: 'model failed' },
    });

    const names = await fsPromises.readdir(run.paths.sessionDirectory);
    expect(names.sort()).toEqual(['final-output.json', 'run-manifest.json', 'trace.jsonl']);
  });

  it('rejects path traversal and existing session directories', async () => {
    const root = await temporaryRoot();

    await expectArtifactError(
      () =>
        createArtifactRun({
          directory: root,
          sessionId: '../private',
          config: config(),
          createdAt,
        }),
      'ARTIFACT_INPUT_INVALID',
    );

    const first = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await first.abort('TEST_ABORT');

    await expectArtifactError(
      () =>
        createArtifactRun({
          directory: root,
          sessionId: 'session-1',
          config: config(),
          createdAt,
        }),
      'ARTIFACT_DIRECTORY_EXISTS',
    );
  });

  it('cleans temporary output and manifest files and preserves a failure marker', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: { password: 'must-not-persist' },
        }),
      'ARTIFACT_INPUT_INVALID',
    );

    const marker = artifactFailureMarkerSchema.parse(
      JSON.parse(await fsPromises.readFile(run.paths.failure, 'utf8')) as unknown,
    );
    expect(marker).toMatchObject({ sessionId: 'session-1', code: 'ARTIFACT_INPUT_INVALID' });
    await expect(fsPromises.readFile(run.paths.manifest, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fsPromises.readFile(run.paths.finalOutput, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('normalizes final-output write failures and publishes a failure marker', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());
    fileFailures.openPath = 'final-output.json.';

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: 'Done',
        }),
      'ARTIFACT_OUTPUT_WRITE_FAILED',
    );

    const marker = artifactFailureMarkerSchema.parse(
      JSON.parse(await fsPromises.readFile(run.paths.failure, 'utf8')) as unknown,
    );
    expect(marker.code).toBe('ARTIFACT_OUTPUT_WRITE_FAILED');
    expect(await fsPromises.readdir(run.paths.sessionDirectory)).toEqual([
      'run-failure.json',
      'trace.jsonl',
    ]);
  });

  it('removes temporary manifest files after an atomic publish failure', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());
    fileFailures.renameTarget = run.paths.manifest;

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: 'Done',
        }),
      'ARTIFACT_MANIFEST_WRITE_FAILED',
    );

    const marker = artifactFailureMarkerSchema.parse(
      JSON.parse(await fsPromises.readFile(run.paths.failure, 'utf8')) as unknown,
    );
    expect(marker.code).toBe('ARTIFACT_MANIFEST_WRITE_FAILED');
    expect((await fsPromises.readdir(run.paths.sessionDirectory)).sort()).toEqual([
      'run-failure.json',
      'trace.jsonl',
    ]);
  });

  it('normalizes trace close errors and keeps the run failure detectable', async () => {
    const root = await temporaryRoot();
    fileFailures.closePath = join(root, '2026-09-21', 'session-1', 'trace.jsonl');
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: 'Done',
        }),
      'ARTIFACT_TRACE_CLOSE_FAILED',
    );

    const marker = artifactFailureMarkerSchema.parse(
      JSON.parse(await fsPromises.readFile(run.paths.failure, 'utf8')) as unknown,
    );
    expect(marker.code).toBe('ARTIFACT_TRACE_CLOSE_FAILED');
    expect(JSON.stringify(marker)).not.toContain('private close path');
  });

  it('writes a failure marker even when cleanup itself fails', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());
    fileFailures.removePath = 'final-output.json';
    fileFailures.removeFailures = 1;

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: { password: 'pseudo-secret' },
        }),
      'ARTIFACT_RUN_FAILED',
    );

    const marker = artifactFailureMarkerSchema.parse(
      JSON.parse(await fsPromises.readFile(run.paths.failure, 'utf8')) as unknown,
    );
    expect(marker).toMatchObject({
      sessionId: 'session-1',
      code: 'ARTIFACT_INPUT_INVALID',
    });
    expect(JSON.stringify(marker)).not.toContain('pseudo-secret');
  });

  it('keeps a detectable failure marker when the trace artifact is damaged', async () => {
    const root = await temporaryRoot();
    const run = await createArtifactRun({
      directory: root,
      sessionId: 'session-1',
      config: config(),
      createdAt,
    });
    await run.trace.append(startedEvent());
    await run.trace.append(completedEvent());
    await fsPromises.rm(run.paths.trace, { force: true });

    await expectArtifactError(
      () =>
        run.finalize({
          status: 'completed',
          completedAt: new Date('2026-09-21T10:00:01.000Z'),
          finalOutput: 'Done',
        }),
      'ARTIFACT_RUN_FAILED',
    );
  });

  it('cleans an empty session directory when the trace file cannot open', async () => {
    const root = await temporaryRoot();
    const occupiedDate = join(root, '2026-09-21');
    await mkdirAsFile(occupiedDate);

    await expectArtifactError(
      () =>
        createArtifactRun({
          directory: root,
          sessionId: 'session-1',
          config: config(),
          createdAt,
        }),
      'ARTIFACT_DIRECTORY_EXISTS',
    );
  });
});

async function mkdirAsFile(path: string): Promise<void> {
  await fsPromises.writeFile(path, 'occupied', 'utf8');
}
