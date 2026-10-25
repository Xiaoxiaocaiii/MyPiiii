import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExperimentConfig } from '../../src/core/config.js';
import { DeepSeekModelAdapter } from '../../src/core/deepseek-model.js';
import { FakeModelAdapter } from '../../src/core/fake-model.js';
import {
  createRealEvalBatchPlan,
  formatRealEvalBatchDryRun,
  persistRealEvalBatchPlan,
  realEvalBatchAuthorizationSchema,
  resumeRealEvalBatch,
  runRealEvalBatch,
  type RealEvalBatchAuthorization,
} from '../../src/eval/real-eval-batch.js';
import { runRealEvalBatchCommand } from '../../src/eval/real-eval-batch-command.js';
import type { RealEvalBatchCommandError } from '../../src/eval/real-eval-batch-command.js';
import { loadTraceRun } from '../../src/observability/trace-loader.js';
import { modelAttemptDiagnosticSchema } from '../../src/observability/model-attempt-diagnostics.js';
import { replayLoadedTrace } from '../../src/observability/trace-replay.js';
import {
  computeRealEvalWorkingTreeDiffSha256,
  createRealEvalSnapshot,
  realEvalSourcePaths,
  type RealEvalSnapshot,
} from '../../src/eval/real-eval-snapshot.js';

const offlineApiKey = 'offline-test-only';
const temporaryDirectories: string[] = [];
let fixtureRoot: string;
let repositoryRoot: string;
let snapshotId = '';
let snapshot: RealEvalSnapshot;

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

async function createBatchFixtures(): Promise<void> {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mypiiii-real-eval-batch-fixtures-'));
  repositoryRoot = join(fixtureRoot, 'repository');
  const evalRoot = join(repositoryRoot, 'docs', 'research', 'real-eval');
  const snapshotsDirectory = join(evalRoot, 'snapshots');
  const tasksDirectory = join(evalRoot, 'tasks');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(snapshotsDirectory, { recursive: true });
  await mkdir(tasksDirectory, { recursive: true });

  const origins = new Map(
    realEvalSourcePaths.map((path) => [
      path,
      { gitStatus: '??', baseSha256: null, diffSha256: null },
    ]),
  );
  const sourceBytes = new Map<string, Buffer>();
  for (const path of realEvalSourcePaths) {
    const contents = Buffer.from(`// test-only source fixture: ${path}\n`, 'utf8');
    sourceBytes.set(path, contents);
    const sourcePath = join(repositoryRoot, ...path.split('/'));
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, contents);
  }
  snapshot = await createRealEvalSnapshot({
    repositoryRoot,
    snapshotsDirectory,
    baseRevision: 'a'.repeat(40),
    workingTreeDiffSha256: computeRealEvalWorkingTreeDiffSha256(
      realEvalSourcePaths.map((path) => ({
        path,
        sha256: sha256(sourceBytes.get(path)!),
        origin: origins.get(path)!,
      })),
    ),
    origins,
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
  });
  snapshotId = snapshot.manifest.snapshotId;

  const tasks = Array.from({ length: 12 }, (_, index) => {
    const taskId = `task-${String(index + 1).padStart(3, '0')}`;
    const contents = Buffer.from(`Test-only task fixture ${taskId}.\n`, 'utf8');
    return {
      taskId,
      snapshotId,
      taskTextPath: `${taskId}.md`,
      taskTextBytes: contents.byteLength,
      taskTextSha256: sha256(contents),
      category: 'context_and_feedback' as const,
      split: taskId === 'task-001' ? ('development' as const) : ('holdout' as const),
      difficulty: 'low' as const,
      difficultyRationale: 'A minimal fixture used only to exercise batch integrity.',
      contents,
    };
  });
  for (const task of tasks) {
    await writeFile(join(tasksDirectory, task.taskTextPath), task.contents);
  }
  await writeFile(
    join(tasksDirectory, 'task-index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      hashAlgorithm: 'sha256',
      accessNote: 'Synthetic unit-test fixture; not an evaluation task set.',
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        snapshotId: task.snapshotId,
        taskTextPath: task.taskTextPath,
        taskTextBytes: task.taskTextBytes,
        taskTextSha256: task.taskTextSha256,
        category: task.category,
        split: task.split,
        difficulty: task.difficulty,
        difficultyRationale: task.difficultyRationale,
      })),
    })}\n`,
  );
}

function config(variant: 'A' | 'B'): ExperimentConfig {
  return {
    schemaVersion: 1,
    configId: 'real-eval-context-ab',
    scenarioId: 'repo-qa',
    model: {
      provider: 'deepseek',
      name: 'deepseek-test-model',
      temperature: 0,
      maxOutputTokens: 4096,
    },
    runtime: { maxTurns: 12, timeoutMs: 120_000 },
    context: {
      maxCharacters: variant === 'A' ? 24_000 : 16_000,
      recentTurns: 4,
      observationMaxCharacters: 5000,
    },
    tools: {
      enabled: ['repo.list_files', 'repo.search_source', 'repo.read_file_lines'],
    },
    artifacts: { directory: './artifacts/real-eval-runs' },
  };
}

function variants() {
  return [
    { variantId: 'A' as const, config: config('A') },
    { variantId: 'B' as const, config: config('B') },
  ];
}

function authorization(batchId: string, maxBudgetUsd = 100): RealEvalBatchAuthorization {
  return realEvalBatchAuthorizationSchema.parse({
    schemaVersion: 1,
    authorizationId: 'offline-test-authorization',
    batchId,
    modelName: 'deepseek-test-model',
    pricingSnapshotId: 'deepseek-flash-2026-10-24',
    split: 'development',
    maxPlanItems: 48,
    maxTotalModelRequests: 624,
    maxBudgetUsd,
    confirmedAt: '2026-10-24T00:00:00.000Z',
  });
}

async function makePlan(batchId: string) {
  return await createRealEvalBatchPlan({
    repositoryRoot,
    batchId,
    snapshotId,
    split: 'development',
    taskIds: ['task-001'],
    variants: variants(),
    repeats: 1,
    orderSeed: 'b2-test-seed',
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
  });
}

beforeAll(async () => {
  await createBatchFixtures();
});

async function temporaryArtifactDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mypiiii-real-eval-batch-'));
  temporaryDirectories.push(directory);
  return directory;
}

function finalAnswerAdapter(): FakeModelAdapter {
  return new FakeModelAdapter([
    {
      type: 'response',
      response: {
        schemaVersion: 1,
        output: {
          schemaVersion: 1,
          type: 'final_answer',
          content: 'A test answer with no claims about a real model run.',
        },
      },
    },
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

afterAll(async () => {
  if (snapshot !== undefined) {
    await Promise.all(
      realEvalSourcePaths.map((path) =>
        chmod(join(snapshot.rootDirectory, ...path.split('/')), 0o644).catch(() => undefined),
      ),
    );
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('real evaluation batch planning', () => {
  it('prints a zero-network dry run with stable identities and persists the plan', async () => {
    const plan = await makePlan('batch-dry-run');
    const output = JSON.parse(formatRealEvalBatchDryRun(plan)) as {
      dryRun: boolean;
      networkModelRequests: number;
      planItemCount: number;
      rows: { taskId: string; taskHash?: string; sessionId: string }[];
    };

    expect(output).toMatchObject({
      dryRun: true,
      networkModelRequests: 0,
      planItemCount: 2,
    });
    expect(output.rows.map(({ taskId }) => taskId)).toEqual(['task-001', 'task-001']);
    expect(new Set(output.rows.map(({ sessionId }) => sessionId)).size).toBe(2);
    expect(plan.manifest.items.every(({ taskHash }) => /^[a-f0-9]{64}$/.test(taskHash))).toBe(true);
    expect(() => {
      const item = plan.manifest.items[0];
      if (item !== undefined) {
        item.taskHash = '0'.repeat(64);
      }
    }).toThrow();

    const artifactDirectory = await temporaryArtifactDirectory();
    const manifestPath = await persistRealEvalBatchPlan(plan, artifactDirectory);
    expect(await readFile(manifestPath, 'utf8')).toContain('"status": "planned"');
  });

  it('validates fixture task bytes while preserving its exact trailing newline', async () => {
    const plan = await makePlan('batch-raw-task');
    const artifactDirectory = await temporaryArtifactDirectory();
    await persistRealEvalBatchPlan(plan, artifactDirectory);
    const taskText = await readFile(
      join(repositoryRoot, 'docs', 'research', 'real-eval', 'tasks', 'task-001.md'),
      'utf8',
    );
    expect(taskText.endsWith('\n')).toBe(true);

    const adapters: FakeModelAdapter[] = [];
    const result = await runRealEvalBatch(plan, {
      authorization: authorization('batch-raw-task'),
      apiKey: offlineApiKey,
      createAdapter: () => {
        const adapter = finalAnswerAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });

    expect(
      result.items.every(
        ({ status, runtimeStatus, startedAt, completedAt }) =>
          status === 'completed' &&
          runtimeStatus === 'completed' &&
          startedAt !== null &&
          completedAt !== null,
      ),
    ).toBe(true);
    expect(adapters).toHaveLength(2);
    expect(adapters.every((adapter) => adapter.requests[0]?.inputMessage === taskText)).toBe(true);
    expect(
      result.items.every(
        ({ offlineValidation }) =>
          offlineValidation?.traceLoaded === true &&
          offlineValidation.replayed === true &&
          offlineValidation.consistent === true,
      ),
    ).toBe(true);
  }, 30_000);
});

describe('real evaluation batch authorization and recovery', () => {
  it('requires explicit paid-batch confirmation at the command boundary', async () => {
    const write = vi.fn<(message: string) => void>();
    await expect(
      runRealEvalBatchCommand(
        [
          'run',
          '--batch-id',
          'batch-command-gate',
          '--artifact-root',
          'artifacts',
          '--authorization',
          'must-not-be-read.json',
        ],
        write,
      ),
    ).rejects.toMatchObject({
      name: 'RealEvalBatchCommandError',
      code: 'BATCH_AUTHORIZATION_REQUIRED',
    } satisfies Partial<RealEvalBatchCommandError>);
    expect(write).not.toHaveBeenCalled();
  });

  it('requires authorization and a credential before any model adapter or fetch is created', async () => {
    const plan = await makePlan('batch-gated');
    const artifactDirectory = await temporaryArtifactDirectory();
    await persistRealEvalBatchPlan(plan, artifactDirectory);
    const createAdapter = vi.fn(() => finalAnswerAdapter());
    const fetchMock = vi.fn<typeof fetch>();

    await expect(runRealEvalBatch(plan, { createAdapter })).rejects.toMatchObject({
      code: 'BATCH_AUTHORIZATION_REQUIRED',
    });
    await expect(
      runRealEvalBatch(plan, {
        authorization: authorization('batch-gated'),
        apiKey: '',
        createAdapter,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'BATCH_CREDENTIALS_MISSING' });
    expect(createAdapter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it('reserves the USD ceiling before requests and preserves the stop across resume', async () => {
    const plan = await makePlan('batch-budget-stop');
    const artifactDirectory = await temporaryArtifactDirectory();
    await persistRealEvalBatchPlan(plan, artifactDirectory);
    const adapters: FakeModelAdapter[] = [];
    const auth = authorization('batch-budget-stop', 0.01);
    const createAdapter = (): FakeModelAdapter => {
      const adapter = finalAnswerAdapter();
      adapters.push(adapter);
      return adapter;
    };

    const result = await runRealEvalBatch(plan, {
      authorization: auth,
      apiKey: offlineApiKey,
      createAdapter,
    });
    const ledgerPath = join(
      artifactDirectory,
      'batches',
      'batch-budget-stop',
      'budget-ledger.json',
    );
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      maxBudgetMicroUsd: number;
      reservedBudgetMicroUsd: number;
      reservedModelRequests: number;
      stopReason: string | null;
    };

    expect(ledger.stopReason).toBe('budget_limit');
    expect(ledger.reservedBudgetMicroUsd).toBeLessThanOrEqual(ledger.maxBudgetMicroUsd);
    expect(ledger.reservedModelRequests).toBeLessThanOrEqual(1);
    expect(
      result.items.some(
        ({ status, failureCode }) =>
          status === 'interrupted' && failureCode === 'BATCH_BUDGET_LIMIT_REACHED',
      ),
    ).toBe(true);
    expect(
      adapters.reduce((total, adapter) => total + adapter.requests.length, 0),
    ).toBeLessThanOrEqual(1);
    expect(result.items.some(({ status }) => status !== 'completed')).toBe(true);

    const resumed = await resumeRealEvalBatch({
      repositoryRoot,
      artifactDirectory,
      batchId: 'batch-budget-stop',
      authorization: auth,
      apiKey: offlineApiKey,
      createAdapter,
    });
    expect(resumed.items.some(({ status }) => status !== 'completed')).toBe(true);
    expect(
      adapters.reduce((total, adapter) => total + adapter.requests.length, 0),
    ).toBeLessThanOrEqual(1);
  }, 30_000);

  it('marks an abandoned started item interrupted and executes only still-planned items', async () => {
    const plan = await makePlan('batch-recovery');
    const artifactDirectory = await temporaryArtifactDirectory();
    const manifestPath = await persistRealEvalBatchPlan(plan, artifactDirectory);
    const authorizationValue = authorization('batch-recovery');
    await writeFile(
      join(artifactDirectory, 'batches', 'batch-recovery', 'budget-ledger.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        batchId: 'batch-recovery',
        authorizationId: authorizationValue.authorizationId,
        modelName: authorizationValue.modelName,
        pricingSnapshotId: authorizationValue.pricingSnapshotId,
        maxBudgetMicroUsd: 100_000_000,
        reservedBudgetMicroUsd: 0,
        maxTotalModelRequests: authorizationValue.maxTotalModelRequests,
        reservedModelRequests: 0,
        stopReason: null,
        updatedAt: '2026-10-24T00:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const stored = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      items: Array<Record<string, unknown>>;
    };
    const abandonedItem = stored.items[0];
    if (abandonedItem === undefined) {
      throw new Error('Expected a persisted batch item');
    }
    abandonedItem['status'] = 'running';
    abandonedItem['startedAt'] = '2026-10-24T00:01:00.000Z';
    await writeFile(manifestPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    const adapters: FakeModelAdapter[] = [];
    const recovered = await resumeRealEvalBatch({
      repositoryRoot,
      artifactDirectory,
      batchId: 'batch-recovery',
      authorization: authorizationValue,
      apiKey: offlineApiKey,
      createAdapter: () => {
        const adapter = finalAnswerAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });

    expect(
      recovered.items.find(({ planItemId }) => planItemId === abandonedItem['planItemId']),
    ).toMatchObject({
      status: 'interrupted',
      failureCode: 'PROCESS_INTERRUPTED',
    });
    expect(
      recovered.items.filter(
        ({ status, startedAt, completedAt }) =>
          status === 'completed' && startedAt !== null && completedAt !== null,
      ),
    ).toHaveLength(1);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.requests).toHaveLength(1);

    const completed = recovered.items.find(({ status }) => status === 'completed');
    if (completed?.artifacts === null || completed?.artifacts === undefined) {
      throw new Error('Expected the resumed item to have run artifacts');
    }
    const sessionDirectory = join(artifactDirectory, completed.artifacts.sessionDirectory);
    const loaded = await loadTraceRun({ sessionDirectory });
    expect(replayLoadedTrace(loaded).status).toBe('completed');
  }, 30_000);

  it('records Runtime failures as failed batch items while preserving valid artifacts', async () => {
    const plan = await makePlan('batch-runtime-failure');
    const artifactDirectory = await temporaryArtifactDirectory();
    await persistRealEvalBatchPlan(plan, artifactDirectory);
    const result = await runRealEvalBatch(plan, {
      authorization: authorization('batch-runtime-failure'),
      apiKey: offlineApiKey,
      createAdapter: () =>
        new FakeModelAdapter([{ type: 'error', cause: 'private provider detail' }]),
    });

    expect(result.status).toBe('completed_with_failures');
    expect(
      result.items.every(
        ({ status, runtimeStatus, runtimeFailureCode }) =>
          status === 'failed' &&
          runtimeStatus === 'failed' &&
          runtimeFailureCode === 'MODEL_CALL_FAILED',
      ),
    ).toBe(true);
    expect(
      result.items.every(
        ({ offlineValidation }) =>
          offlineValidation?.traceLoaded === true &&
          offlineValidation.replayed === true &&
          offlineValidation.consistent === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  }, 30_000);

  it('persists each DeepSeek attempt diagnostic beside its run artifacts', async () => {
    const plan = await makePlan('batch-diagnostics-integration');
    const artifactDirectory = await temporaryArtifactDirectory();
    await persistRealEvalBatchPlan(plan, artifactDirectory);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          model: 'deepseek-test-model-release',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  type: 'final_answer',
                  content: 'Offline transport integration answer.',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
      ),
    );
    const result = await runRealEvalBatch(plan, {
      authorization: authorization('batch-diagnostics-integration'),
      apiKey: offlineApiKey,
      fetch: fetchMock,
      createAdapter: () => new DeepSeekModelAdapter({ apiKey: offlineApiKey, fetch: fetchMock }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.artifacts).not.toBeNull();
      const diagnosticsPath = join(artifactDirectory, item.artifacts!.modelAttempts);
      const lines = (await readFile(diagnosticsPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(modelAttemptDiagnosticSchema.parse(JSON.parse(lines[0] ?? ''))).toMatchObject({
        sessionId: item.sessionId,
        modelName: 'deepseek-test-model',
        httpStatus: 200,
        remoteModel: 'deepseek-test-model-release',
        finishReason: 'stop',
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
        responseParseCategory: 'accepted',
        actionSchemaValid: true,
      });
    }
  }, 30_000);
});
