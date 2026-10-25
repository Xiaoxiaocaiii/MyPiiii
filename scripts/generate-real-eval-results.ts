import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  adjudicateRealEvalSample,
  hashRealEvalRubrics,
  parseRealEvalRubrics,
  realEvalAdjudicationDatasetSchema,
  realEvalBlindPacketSchema,
  realEvalUnblindingEntrySchema,
  unblindRealEvalAdjudications,
} from '../src/eval/real-eval-adjudication.js';
import {
  createRealEvalBatchPlan,
  realEvalBatchManifestSchema,
  type RealEvalBatchManifest,
} from '../src/eval/real-eval-batch.js';
import {
  realEvalSnapshotManifestSchema,
  verifyRealEvalSnapshot,
} from '../src/eval/real-eval-snapshot.js';
import { analyzeTraceConsistency } from '../src/observability/trace-consistency.js';
import { loadTraceRun } from '../src/observability/trace-loader.js';
import { replayTraceRun } from '../src/observability/trace-replay.js';
import { DatabaseSync } from 'node:sqlite';
import { format as formatWithPrettier } from 'prettier';

const repositoryRoot = resolve(process.cwd());
const resultsRoot = join(repositoryRoot, 'docs', 'research', 'real-eval');
const snapshotId = '62cded2474cd1f57d3e1387bd12889e049e6e782a968525ee6ead018b7c5d0d3';
const pricingSnapshotId = 'deepseek-flash-2026-10-24';
const inputPriceUsdPerMillion = 0.3;
const outputPriceUsdPerMillion = 1.2;
const outputPaths = [
  join(resultsRoot, '02-results.md'),
  join(resultsRoot, 'results.json'),
  join(resultsRoot, 'runs.csv'),
  join(resultsRoot, 'adjudications.json'),
] as const;

interface TaskIndex {
  readonly snapshotId: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly taskTextPath: string;
    readonly taskTextSha256: string;
    readonly category: string;
    readonly split: string;
    readonly difficulty: string;
  }[];
}

interface ModelAttempt {
  readonly httpStatus: number | null;
  readonly remoteModel: string | null;
  readonly finishReason: string | null;
  readonly responseParseCategory: string | null;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

interface RunRow {
  readonly batchId: string;
  readonly batchPlanHash: string;
  readonly planItemId: string;
  readonly taskId: string;
  readonly category: string;
  readonly split: string;
  readonly variantId: string;
  readonly repeat: number;
  readonly configHash: string;
  readonly status: string;
  readonly runtimeStatus: string | null;
  readonly runtimeFailureCode: string | null;
  readonly failureCode: string | null;
  readonly sessionId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly modelRequests: number;
  readonly http200Responses: number;
  readonly remoteModels: readonly string[];
  readonly finishReasonCounts: Readonly<Record<string, number>>;
  readonly parseCategoryCounts: Readonly<Record<string, number>>;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly allRequestsHaveUsage: boolean;
  readonly estimatedPeakCacheMissCostUsd: number | null;
  readonly actualCostUsd: null;
  readonly toolCalls: number;
  readonly toolCompleted: number;
  readonly toolFailed: number;
  readonly toolErrorCounts: Readonly<Record<string, number>>;
  readonly contextRequestPairs: number;
  readonly contextsMatchRequests: boolean;
  readonly traceEvents: number;
  readonly traceLoaded: boolean | null;
  readonly replayed: boolean | null;
  readonly consistent: boolean | null;
  readonly issueCodes: readonly string[];
  readonly finalAnswerAvailable: boolean;
  readonly adjudicationStatus: string;
  readonly artifacts: {
    readonly trace: string | null;
    readonly manifest: string | null;
    readonly finalOutput: string | null;
    readonly modelAttempts: string | null;
  };
}

interface CsvColumn {
  readonly key: keyof RunRow;
  readonly header: string;
}

const csvColumns: readonly CsvColumn[] = [
  { key: 'batchId', header: 'batch_id' },
  { key: 'batchPlanHash', header: 'batch_plan_hash' },
  { key: 'planItemId', header: 'plan_item_id' },
  { key: 'taskId', header: 'task_id' },
  { key: 'category', header: 'category' },
  { key: 'split', header: 'split' },
  { key: 'variantId', header: 'variant' },
  { key: 'repeat', header: 'repeat' },
  { key: 'configHash', header: 'config_hash' },
  { key: 'status', header: 'run_status' },
  { key: 'runtimeStatus', header: 'runtime_status' },
  { key: 'runtimeFailureCode', header: 'runtime_failure_code' },
  { key: 'failureCode', header: 'failure_code' },
  { key: 'sessionId', header: 'session_id' },
  { key: 'startedAt', header: 'started_at' },
  { key: 'completedAt', header: 'completed_at' },
  { key: 'modelRequests', header: 'model_requests' },
  { key: 'http200Responses', header: 'http_200_responses' },
  { key: 'remoteModels', header: 'remote_models' },
  { key: 'finishReasonCounts', header: 'finish_reason_counts' },
  { key: 'parseCategoryCounts', header: 'parse_category_counts' },
  { key: 'promptTokens', header: 'prompt_tokens' },
  { key: 'completionTokens', header: 'completion_tokens' },
  { key: 'totalTokens', header: 'total_tokens' },
  { key: 'allRequestsHaveUsage', header: 'all_requests_have_usage' },
  { key: 'estimatedPeakCacheMissCostUsd', header: 'estimated_peak_cache_miss_cost_usd' },
  { key: 'actualCostUsd', header: 'actual_cost_usd' },
  { key: 'toolCalls', header: 'tool_calls' },
  { key: 'toolCompleted', header: 'tool_completed' },
  { key: 'toolFailed', header: 'tool_failed' },
  { key: 'toolErrorCounts', header: 'tool_error_counts' },
  { key: 'contextRequestPairs', header: 'context_request_pairs' },
  { key: 'contextsMatchRequests', header: 'contexts_match_requests' },
  { key: 'traceEvents', header: 'trace_events' },
  { key: 'traceLoaded', header: 'trace_loaded' },
  { key: 'replayed', header: 'replayed' },
  { key: 'consistent', header: 'consistent' },
  { key: 'issueCodes', header: 'issue_codes' },
  { key: 'finalAnswerAvailable', header: 'final_answer_available' },
  { key: 'adjudicationStatus', header: 'adjudication_status' },
  { key: 'artifacts', header: 'artifact_paths' },
];

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function countBy(values: readonly (string | null | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value !== null && value !== undefined) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function estimatePeakCostUsd(promptTokens: number, completionTokens: number): number {
  const amount =
    (promptTokens * inputPriceUsdPerMillion + completionTokens * outputPriceUsdPerMillion) /
    1_000_000;
  return Number(amount.toFixed(6));
}

function csvCell(value: unknown): string {
  let text = '';
  if (value !== null && value !== undefined) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      text = `${value}`;
    } else {
      text = JSON.stringify(value) ?? '';
    }
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeDeterministicBlindId(batchId: string, planItemId: string): string {
  const digest = sha256(`${batchId}:${planItemId}`);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return `blind-${uuid}`;
}

function summarizeRows(rows: readonly RunRow[]) {
  const attemptsWithUsage = rows.reduce(
    (sum, row) => sum + (row.allRequestsHaveUsage ? row.modelRequests : 0),
    0,
  );
  const promptTokens = rows.reduce((sum, row) => sum + row.promptTokens, 0);
  const completionTokens = rows.reduce((sum, row) => sum + row.completionTokens, 0);
  const byStatus = countBy(rows.map((row) => row.status));
  const byFailureCode = countBy(rows.map((row) => row.failureCode));
  const hasRequests = rows.some((row) => row.modelRequests > 0);
  const allRequestsHaveUsage =
    !hasRequests || attemptsWithUsage === rows.reduce((sum, row) => sum + row.modelRequests, 0);
  return {
    planned: rows.length,
    started: rows.filter((row) => row.status !== 'planned').length,
    completed: rows.filter((row) => row.runtimeStatus === 'completed').length,
    failed: byStatus['failed'] ?? 0,
    interrupted: byStatus['interrupted'] ?? 0,
    notRun: byStatus['planned'] ?? 0,
    finalAnswers: rows.filter((row) => row.finalAnswerAvailable).length,
    notAssessableAnswers: rows.filter(
      (row) => row.status !== 'planned' && !row.finalAnswerAvailable,
    ).length,
    observedStrictPasses: 0,
    failureCodes: byFailureCode,
    modelRequests: rows.reduce((sum, row) => sum + row.modelRequests, 0),
    http200Responses: rows.reduce((sum, row) => sum + row.http200Responses, 0),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    allRequestsHaveUsage,
    estimatedPeakCacheMissCostUsd: allRequestsHaveUsage
      ? estimatePeakCostUsd(promptTokens, completionTokens)
      : null,
    actualCostUsd: null,
    toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
    toolCompleted: rows.reduce((sum, row) => sum + row.toolCompleted, 0),
    toolFailed: rows.reduce((sum, row) => sum + row.toolFailed, 0),
  };
}

async function collectRunRow(
  batch: RealEvalBatchManifest,
  item: RealEvalBatchManifest['items'][number],
  task: TaskIndex['tasks'][number],
  database: DatabaseSync,
): Promise<RunRow> {
  const emptyCounts = {};
  if (item.status === 'running') {
    throw new Error(`Refusing to report a still-running plan item: ${item.planItemId}`);
  }
  if (item.status === 'planned') {
    return {
      batchId: batch.batchId,
      batchPlanHash: batch.planHash,
      planItemId: item.planItemId,
      taskId: item.taskId,
      category: task.category,
      split: item.split,
      variantId: item.variantId,
      repeat: item.repeat,
      configHash: item.configHash,
      status: item.status,
      runtimeStatus: null,
      runtimeFailureCode: null,
      failureCode: null,
      sessionId: item.sessionId,
      startedAt: null,
      completedAt: null,
      modelRequests: 0,
      http200Responses: 0,
      remoteModels: [],
      finishReasonCounts: emptyCounts,
      parseCategoryCounts: emptyCounts,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      allRequestsHaveUsage: false,
      estimatedPeakCacheMissCostUsd: null,
      actualCostUsd: null,
      toolCalls: 0,
      toolCompleted: 0,
      toolFailed: 0,
      toolErrorCounts: emptyCounts,
      contextRequestPairs: 0,
      contextsMatchRequests: false,
      traceEvents: 0,
      traceLoaded: null,
      replayed: null,
      consistent: null,
      issueCodes: [],
      finalAnswerAvailable: false,
      adjudicationStatus: 'not_run',
      artifacts: { trace: null, manifest: null, finalOutput: null, modelAttempts: null },
    };
  }

  const artifacts = item.artifacts;
  if (artifacts === null) {
    throw new Error(`Started plan item has no artifact references: ${item.planItemId}`);
  }
  const attemptPath = join(resultsRoot, artifacts.modelAttempts);
  const attemptText = await readFile(attemptPath, 'utf8');
  const attempts = attemptText
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ModelAttempt);
  const sessionDirectory = join(resultsRoot, artifacts.sessionDirectory);
  const loaded = await loadTraceRun({ sessionDirectory });
  const replay = await replayTraceRun({ sessionDirectory });
  const indexed = database
    .prepare('SELECT status FROM runs WHERE session_id = ?')
    .get(item.sessionId) as { readonly status: string } | undefined;
  if (indexed === undefined) {
    throw new Error(`SQLite row is missing for ${item.sessionId}`);
  }
  if (!['running', 'completed', 'failed'].includes(indexed.status)) {
    throw new Error(`Unexpected SQLite run status for ${item.sessionId}: ${indexed.status}`);
  }
  const consistency = analyzeTraceConsistency(loaded, {
    sqliteStatus: indexed.status as 'running' | 'completed' | 'failed',
  });
  if (
    !consistency.consistent ||
    replay.sessionId !== item.sessionId ||
    replay.status !== item.offlineValidation?.replayStatus
  ) {
    throw new Error(`Trace, Replay, or SQLite consistency check failed for ${item.sessionId}`);
  }

  const events = loaded.events;
  const modelRequestEvents = events.filter((event) => event.eventType === 'model.requested');
  const contextEvents = events.filter((event) => event.eventType === 'context.built');
  const contexts = new Map(
    contextEvents.map((event) => [
      event.turnIndex,
      JSON.stringify((event.payload as { readonly context: unknown }).context),
    ]),
  );
  const contextsMatchRequests =
    contextEvents.length === modelRequestEvents.length &&
    contexts.size === contextEvents.length &&
    new Set(modelRequestEvents.map((event) => event.turnIndex)).size ===
      modelRequestEvents.length &&
    modelRequestEvents.every((event) => {
      const payload = event.payload as { readonly request: { readonly context: unknown } };
      return contexts.get(event.turnIndex) === JSON.stringify(payload.request.context);
    });
  if (attempts.length !== modelRequestEvents.length || !contextsMatchRequests) {
    throw new Error(`Model attempts and Trace requests do not match for ${item.sessionId}`);
  }

  const usageAttempts = attempts.filter((attempt) => attempt.usage !== undefined);
  const promptTokens = usageAttempts.reduce(
    (sum, attempt) => sum + (attempt.usage?.promptTokens ?? 0),
    0,
  );
  const completionTokens = usageAttempts.reduce(
    (sum, attempt) => sum + (attempt.usage?.completionTokens ?? 0),
    0,
  );
  const totalTokens = usageAttempts.reduce(
    (sum, attempt) => sum + (attempt.usage?.totalTokens ?? 0),
    0,
  );
  const allRequestsHaveUsage = usageAttempts.length === attempts.length;
  const toolFailures = events.filter((event) => event.eventType === 'tool.failed');
  const toolCalls = events.filter((event) => event.eventType === 'tool.requested').length;
  const toolCompleted = events.filter((event) => event.eventType === 'tool.completed').length;
  const toolErrorCounts = countBy(
    toolFailures.map((event) => (event.payload as { readonly code: string }).code),
  );
  const finalAnswerAvailable = item.runtimeStatus === 'completed';

  return {
    batchId: batch.batchId,
    batchPlanHash: batch.planHash,
    planItemId: item.planItemId,
    taskId: item.taskId,
    category: task.category,
    split: item.split,
    variantId: item.variantId,
    repeat: item.repeat,
    configHash: item.configHash,
    status: item.status,
    runtimeStatus: item.runtimeStatus,
    runtimeFailureCode: item.runtimeFailureCode,
    failureCode: item.failureCode,
    sessionId: item.sessionId,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    modelRequests: attempts.length,
    http200Responses: attempts.filter((attempt) => attempt.httpStatus === 200).length,
    remoteModels: [
      ...new Set(
        attempts
          .map((attempt) => attempt.remoteModel)
          .filter((model): model is string => model !== null),
      ),
    ].sort(),
    finishReasonCounts: countBy(attempts.map((attempt) => attempt.finishReason)),
    parseCategoryCounts: countBy(attempts.map((attempt) => attempt.responseParseCategory)),
    promptTokens,
    completionTokens,
    totalTokens,
    allRequestsHaveUsage,
    estimatedPeakCacheMissCostUsd: allRequestsHaveUsage
      ? estimatePeakCostUsd(promptTokens, completionTokens)
      : null,
    actualCostUsd: null,
    toolCalls,
    toolCompleted,
    toolFailed: toolFailures.length,
    toolErrorCounts,
    contextRequestPairs: modelRequestEvents.length,
    contextsMatchRequests,
    traceEvents: events.length,
    traceLoaded: true,
    replayed: true,
    consistent: consistency.consistent,
    issueCodes: consistency.issues.map((issue) => issue.code),
    finalAnswerAvailable,
    adjudicationStatus: finalAnswerAvailable
      ? 'pending_semantic_review'
      : 'not_assessable_no_answer',
    artifacts: {
      trace: artifacts.trace,
      manifest: artifacts.manifest,
      finalOutput: artifacts.finalOutput,
      modelAttempts: artifacts.modelAttempts,
    },
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  if (!force) {
    for (const path of outputPaths) {
      try {
        await access(path);
        throw new Error(`Output already exists; pass --force to regenerate: ${path}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Output already exists;')) {
          throw error;
        }
      }
    }
  }

  const taskIndex = await readJson<TaskIndex>(join(resultsRoot, 'tasks', 'task-index.json'));
  if (taskIndex.snapshotId !== snapshotId) {
    throw new Error('The task index snapshot does not match this results batch');
  }
  const rubricInput = await readJson<unknown>(join(resultsRoot, 'rubrics', 'rubrics.json'));
  const rubrics = parseRealEvalRubrics(rubricInput);
  const rubricHash = hashRealEvalRubrics(rubricInput);
  const snapshotManifest = realEvalSnapshotManifestSchema.parse(
    await readJson<unknown>(join(resultsRoot, 'snapshots', `${snapshotId}.manifest.json`)),
  );
  const snapshot = await verifyRealEvalSnapshot(
    join(resultsRoot, 'snapshots', snapshotId),
    snapshotManifest,
    join(resultsRoot, 'snapshots', `${snapshotId}.manifest.json`),
  );
  const taskById = new Map(taskIndex.tasks.map((task) => [task.taskId, task]));
  const rubricByTaskId = new Map(rubrics.tasks.map((rubric) => [rubric.taskId, rubric]));
  const questionByTaskId = new Map<string, string>();
  for (const task of taskIndex.tasks) {
    const question = await readFile(join(resultsRoot, 'tasks', task.taskTextPath), 'utf8');
    if (sha256(question) !== task.taskTextSha256) {
      throw new Error(`Task text hash mismatch: ${task.taskId}`);
    }
    questionByTaskId.set(task.taskId, question);
  }

  const batchIds = ['real-eval-dev-20261024', 'real-eval-holdout-main-v2'] as const;
  const database = new DatabaseSync(join(resultsRoot, 'real-eval-runs.sqlite'), {
    readOnly: true,
  });
  const batches: RealEvalBatchManifest[] = [];
  const runRows: RunRow[] = [];
  try {
    for (const batchId of batchIds) {
      const batch = realEvalBatchManifestSchema.parse(
        await readJson<unknown>(join(resultsRoot, 'batches', batchId, 'batch-manifest.json')),
      );
      const regeneratedPlan = await createRealEvalBatchPlan({
        repositoryRoot,
        batchId: batch.batchId,
        snapshotId: batch.snapshotId,
        split: batch.split,
        taskIds: batch.taskIds,
        variants: batch.variants.map((variant) => ({
          variantId: variant.variantId,
          config: variant.config,
        })),
        repeats: batch.repeats,
        orderSeed: batch.orderSeed,
        createdAt: new Date(batch.createdAt),
      });
      if (regeneratedPlan.manifest.planHash !== batch.planHash) {
        throw new Error(`Plan hash mismatch: ${batch.batchId}`);
      }
      const regeneratedIds = regeneratedPlan.manifest.items.map((item) => item.planItemId);
      const storedIds = batch.items.map((item) => item.planItemId);
      if (JSON.stringify(regeneratedIds) !== JSON.stringify(storedIds)) {
        throw new Error(`Plan order mismatch: ${batch.batchId}`);
      }
      batches.push(batch);

      for (const item of batch.items) {
        const task = taskById.get(item.taskId);
        if (task === undefined) {
          throw new Error(`Task metadata is missing: ${item.taskId}`);
        }
        runRows.push(await collectRunRow(batch, item, task, database));
      }
    }
  } finally {
    database.close();
  }

  const summaries = {
    overall: summarizeRows(runRows),
    development: summarizeRows(runRows.filter((row) => row.split === 'development')),
    holdout: summarizeRows(runRows.filter((row) => row.split === 'holdout')),
    holdoutByVariant: {
      A: summarizeRows(runRows.filter((row) => row.split === 'holdout' && row.variantId === 'A')),
      B: summarizeRows(runRows.filter((row) => row.split === 'holdout' && row.variantId === 'B')),
    },
  };
  const taskIndexSha256 = sha256(await readFile(join(resultsRoot, 'tasks', 'task-index.json')));
  const generatedAt = new Date().toISOString();
  const ledgerByBatch = new Map(
    await Promise.all(
      batches.map(
        async (batch) =>
          [
            batch.batchId,
            await readJson<{
              readonly maxBudgetMicroUsd: number;
              readonly reservedBudgetMicroUsd: number;
              readonly maxTotalModelRequests: number;
              readonly reservedModelRequests: number;
              readonly stopReason: string | null;
            }>(join(resultsRoot, 'batches', batch.batchId, 'budget-ledger.json')),
          ] as const,
      ),
    ),
  );

  const completedRows = runRows.filter((row) => row.status !== 'planned');
  const blindPackets = [];
  const unblindingKey = [];
  const adjudicationRecords = [];
  for (const row of completedRows) {
    if (row.finalAnswerAvailable) {
      continue;
    }
    const question = questionByTaskId.get(row.taskId)!;
    const blindSampleId = makeDeterministicBlindId(row.batchId, row.planItemId);
    const packet = realEvalBlindPacketSchema.parse({
      schemaVersion: 1,
      blindSampleId,
      taskId: row.taskId,
      snapshotId,
      question,
      answer: null,
    });
    const batch = batches.find((entry) => entry.batchId === row.batchId)!;
    const item = batch.items.find((entry) => entry.planItemId === row.planItemId)!;
    const artifacts = item.artifacts!;
    const key = realEvalUnblindingEntrySchema.parse({
      blindSampleId,
      taskId: row.taskId,
      taskHash: item.taskHash,
      planItemId: row.planItemId,
      sessionId: row.sessionId,
      variantId: row.variantId,
      configHash: row.configHash,
      runStatus: item.status,
      runtimeFailureCode: item.runtimeFailureCode,
      artifacts: {
        tracePath: artifacts.trace,
        manifestPath: artifacts.manifest,
        finalOutputPath: artifacts.finalOutput,
        modelAttemptsPath: artifacts.modelAttempts,
      },
    });
    const adjudication = await adjudicateRealEvalSample({
      packet,
      rubric: rubricByTaskId.get(row.taskId)!,
      rubricHash,
      snapshot,
    });
    blindPackets.push(packet);
    unblindingKey.push(key);
    adjudicationRecords.push(adjudication);
  }
  const adjudicationDataset = realEvalAdjudicationDatasetSchema.parse({
    schemaVersion: 1,
    snapshotId,
    rubricHash,
    assessmentMethod: 'ai_assisted_source_review',
    records: adjudicationRecords,
  });
  const unblindedRecords = unblindRealEvalAdjudications(adjudicationRecords, unblindingKey);
  const plannedItemIds = runRows
    .filter((row) => row.status === 'planned')
    .map((row) => row.planItemId);
  const adjudicationsDocument = {
    schemaVersion: 1,
    generatedAt,
    snapshotId,
    rubricHash,
    semanticReviewPerformed: false,
    reviewStatus: 'not_performed_no_final_answers',
    reviewNote:
      'The records below are mechanically generated not_assessable placeholders for started runs without a final answer. No AI or human semantic answer review was performed.',
    blindPackets,
    adjudicationDataset,
    unblindedRecords,
    notRunPlanItemIds: plannedItemIds,
    completedRunsPendingReview: runRows
      .filter((row) => row.finalAnswerAvailable)
      .map((row) => row.planItemId),
  };

  const taskSummaries = taskIndex.tasks.map((task) => ({
    ...task,
    plannedRuns: runRows.filter((row) => row.taskId === task.taskId).length,
    startedRuns: runRows.filter((row) => row.taskId === task.taskId && row.status !== 'planned')
      .length,
    questionPath: `tasks/${task.taskTextPath}`,
  }));
  const resultsDocument = {
    schemaVersion: 1,
    generatedAt,
    experimentStatus: 'incomplete',
    experimentStatusNote:
      'The holdout plan has unrun items and no started run produced a final answer. This report does not claim the multi-task evaluation is complete.',
    modelName: 'deepseek-flash',
    pricingSnapshotId,
    pricing: {
      inputCacheMissUsdPerMillionTokens: inputPriceUsdPerMillion,
      outputUsdPerMillionTokens: outputPriceUsdPerMillion,
      actualProviderBillUsd: null,
      costEstimateMethod: 'reported usage at peak cache-miss input and output rates',
    },
    snapshotId,
    taskIndexSha256,
    rubricHash,
    batches: batches.map((batch) => ({
      batchId: batch.batchId,
      split: batch.split,
      status: batch.status,
      planHash: batch.planHash,
      planItems: batch.items.length,
      budgetLedger: ledgerByBatch.get(batch.batchId),
    })),
    summaries,
    tasks: taskSummaries,
    runs: runRows,
    adjudicationArtifact: 'adjudications.json',
    csvArtifact: 'runs.csv',
    noModelRequestsDuringReportGeneration: true,
  };

  const csv = [
    csvColumns.map((column) => column.header).join(','),
    ...runRows.map((row) => csvColumns.map((column) => csvCell(row[column.key])).join(',')),
    '',
  ].join('\r\n');
  const report = renderReport({
    generatedAt,
    batches,
    taskSummaries,
    runRows,
    summaries,
    ledgerByBatch,
    taskIndexSha256,
    rubricHash,
  });

  const outputs = [
    [outputPaths[0], report],
    [outputPaths[1], `${JSON.stringify(resultsDocument, null, 2)}\n`],
    [outputPaths[2], csv],
    [outputPaths[3], `${JSON.stringify(adjudicationsDocument, null, 2)}\n`],
  ] as const;
  for (const [path, contents] of outputs) {
    const formattedContents =
      path.endsWith('.md') || path.endsWith('.json')
        ? await formatWithPrettier(contents, { filepath: path })
        : contents;
    await writeFile(path, formattedContents, 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        generated: outputs.map(([path]) => path),
        overall: summaries.overall,
        adjudications: adjudicationRecords.length,
        notRunPlanItems: plannedItemIds.length,
      },
      null,
      2,
    ),
  );
}

function renderReport(input: {
  readonly generatedAt: string;
  readonly batches: readonly RealEvalBatchManifest[];
  readonly taskSummaries: readonly {
    readonly taskId: string;
    readonly category: string;
    readonly split: string;
    readonly difficulty: string;
    readonly plannedRuns: number;
    readonly startedRuns: number;
    readonly questionPath: string;
  }[];
  readonly runRows: readonly RunRow[];
  readonly summaries: {
    readonly overall: ReturnType<typeof summarizeRows>;
    readonly development: ReturnType<typeof summarizeRows>;
    readonly holdout: ReturnType<typeof summarizeRows>;
    readonly holdoutByVariant: {
      readonly A: ReturnType<typeof summarizeRows>;
      readonly B: ReturnType<typeof summarizeRows>;
    };
  };
  readonly ledgerByBatch: ReadonlyMap<
    string,
    {
      readonly maxBudgetMicroUsd: number;
      readonly reservedBudgetMicroUsd: number;
      readonly maxTotalModelRequests: number;
      readonly reservedModelRequests: number;
      readonly stopReason: string | null;
    }
  >;
  readonly taskIndexSha256: string;
  readonly rubricHash: string;
}): string {
  const { overall, development, holdout, holdoutByVariant } = input.summaries;
  const batchLink = (batchId: string) => `batches/${batchId}/batch-manifest.json`;
  const categoryName: Readonly<Record<string, string>> = {
    control_flow_and_errors: '控制流与异常',
    tool_permissions_and_input_boundaries: '工具权限与输入边界',
    context_and_feedback: 'Context 与反馈',
    trace_and_evidence: 'Trace 与证据',
  };
  const taskTable = input.taskSummaries
    .map(
      (task) =>
        `| [${task.taskId}](${task.questionPath}) | ${task.split} | ${categoryName[task.category] ?? task.category} | ${task.difficulty} | ${task.plannedRuns} | ${task.startedRuns} |`,
    )
    .join('\n');
  const runTable = input.runRows
    .filter((row) => row.status !== 'planned')
    .map((row) => {
      const trace = `[Trace](${row.artifacts.trace})`;
      const output = `[终态工件](${row.artifacts.finalOutput})`;
      const attempts = `[请求诊断](${row.artifacts.modelAttempts})`;
      const reason = row.failureCode ?? row.runtimeFailureCode ?? '未记录';
      return `| ${row.split} | ${row.planItemId} | ${row.variantId} | ${row.status} / \`${reason}\` | ${row.modelRequests} | ${row.toolCalls}（${row.toolCompleted}/${row.toolFailed}） | ${row.totalTokens} | 无 | ${trace} · ${output} · ${attempts} |`;
    })
    .join('\n');
  const batchTable = input.batches
    .map((batch) => {
      const summary = batch.split === 'development' ? development : holdout;
      return `| ${batch.split} | ${batch.status} | ${summary.planned} | ${summary.started} | ${summary.completed} | ${summary.failed} | ${summary.interrupted} | ${summary.notRun} | ${summary.modelRequests} | ${summary.promptTokens} | ${summary.completionTokens} | ${formatUsd(summary.estimatedPeakCacheMissCostUsd)} |`;
    })
    .join('\n');
  const variantTable = (['A', 'B'] as const)
    .map((variant) => {
      const summary = holdoutByVariant[variant];
      return `| ${variant} | ${variant === 'A' ? '24,000' : '16,000'} | ${summary.planned} | ${summary.started} | ${summary.failed} | ${summary.interrupted} | ${summary.notRun} | ${summary.modelRequests} | ${summary.finalAnswers} |`;
    })
    .join('\n');
  const batchLedgers = input.batches
    .map((batch) => {
      const ledger = input.ledgerByBatch.get(batch.batchId)!;
      return `- \`${batch.batchId}\`：${ledger.reservedModelRequests}/${ledger.maxTotalModelRequests} 次请求预留，${formatUsd(ledger.reservedBudgetMicroUsd / 1_000_000)} / ${formatUsd(ledger.maxBudgetMicroUsd / 1_000_000)} 预算预留；停止原因：\`${ledger.stopReason ?? 'none'}\`。`;
    })
    .join('\n');
  const failedReasons = Object.entries(
    countBy(
      input.runRows
        .filter((row) => row.split === 'holdout' && row.status === 'failed')
        .map((row) => row.failureCode),
    ),
  )
    .map(([code, count]) => `\`${code}\` ${count} 项`)
    .join('、');
  const requestsWithStatus = overall.http200Responses;

  return `# 多任务 DeepSeek 真实源码评测结果（部分执行）

> 生成时间：${input.generatedAt}
> 状态：**未完成**。本报告只汇总已冻结批次的真实运行与未运行计划项，不将部分执行表述为完成评测。

## 结论

本实验冻结计划为 4 个开发运行和 48 个留出运行，共 52 项。实际启动 16 项：开发集 4 项全部以 \`MAX_TURNS_EXCEEDED\` 失败；留出集启动 12 项，其中 11 项失败、1 项被预算门禁中断。**没有任何运行产生最终答案，0/16 个已启动运行可做内容判定；留出集仍有 36 项未运行。**因此目前无法判断 A/B 哪种配置更能正确回答问题，也不能声称多任务评测已完成。

这些是自动汇总的真实 DeepSeek 运行结果，不是 Fake Adapter 夹具或自动化测试输出。E1 自动化测试结果见 [执行清单](../../interview-prep/09-real-task-evaluation-tasks.md#e1-工程验收)，不计入下表的真实运行数。

## 实验范围

- 模型别名：\`deepseek-flash\`；请求诊断中远端返回别名一致，但未固定或证明供应商内部模型版本。
- 冻结源码快照：\`${snapshotId}\`；任务索引 SHA-256：\`${input.taskIndexSha256}\`；Rubric SHA-256：\`${input.rubricHash}\`。评分依据未传给受测模型。
- 除 Context 字符预算外其余运行参数保持冻结：A 为 24,000 字符，B 为 16,000 字符；每次最多 12 轮、输出上限 4,096 tokens。字符预算不是 Token 预算。
- 开发批 Manifest：[开发批](${batchLink('real-eval-dev-20261024')})，哈希 \`${input.batches.find((batch) => batch.split === 'development')?.planHash}\`。
- 留出批 Manifest：[留出批](${batchLink('real-eval-holdout-main-v2')})，哈希 \`${input.batches.find((batch) => batch.split === 'holdout')?.planHash}\`。

## 题目覆盖

题面文件链接指向冻结题目原文。开发集与留出集分开列示；开始数按计划项计，不把重复运行当成新的独立问题。

| 题目 | 拆分 | 类别 | 难度 | 计划运行 | 已启动 |
| --- | --- | --- | --- | ---: | ---: |
${taskTable}

## 运行汇总

| 拆分 | 批次状态 | 计划 | 已启动 | Runtime 完成 | 失败 | 中断 | 未运行 | 请求数 | Prompt tokens | Completion tokens | 峰值缓存未命中费用估算 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${batchTable}

总体：计划 ${overall.planned} 项，已启动 ${overall.started} 项；Runtime 完成 ${overall.completed}、失败 ${overall.failed}、中断 ${overall.interrupted}、未运行 ${overall.notRun}。已记录 ${overall.modelRequests} 次请求，其中 ${requestsWithStatus} 次返回 HTTP 200。Usage 合计 ${overall.promptTokens} prompt、${overall.completionTokens} completion、${overall.totalTokens} total tokens。按 C1 高峰缓存未命中输入价 \`$${inputPriceUsdPerMillion}/M\` 和输出价 \`$${outputPriceUsdPerMillion}/M\` 估算约 ${formatUsd(overall.estimatedPeakCacheMissCostUsd)}；**这不是供应商账单**，缓存拆分和实际费用未知。

## 留出配置观察

| 配置 | Context 字符预算 | 计划项 | 已启动 | 失败 | 中断 | 未运行 | 请求数 | 最终答案 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${variantTable}

A 共启动 ${holdoutByVariant.A.started} 项，B 共启动 ${holdoutByVariant.B.started} 项；所有已启动项都没有最终答案。这个样本只能描述运行覆盖和执行终态，不能比较答案质量、严格通过率或 Context 配置效果。留出执行顺序按冻结种子交错，但预算在批次进行中耗尽，因此两配置启动数不相等。

## 已启动运行与证据

“工具数”格式为调用数（成功/失败）。终态工件仅含失败/中断信息，不是模型最终回答。

| 拆分 | 计划项 | 配置 | 运行终态 / 原因 | 请求数 | 工具数（成功/失败） | Total tokens | 最终答案 | 可复核工件 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
${runTable}

## 失败与判定

- 开发批 4 项均以 \`MAX_TURNS_EXCEEDED\` 结束，共 48 次真实请求，均无最终答案。
- 留出批 12 项中：${failedReasons}；另有 1 项以批次级 \`BATCH_BUDGET_LIMIT_REACHED\` 中断。留出批 88 次真实请求均返回 HTTP 200，但 HTTP 成功不等于 Runtime 完成或答案正确。
- 留出工具共 82 次：57 次成功、25 次 \`repo.read_file_lines\` 参数校验为 \`INPUT_INVALID\`。持久化参数已脱敏，不能从现有材料确定具体无效字段或归因于模型/Harness。
- 所有已启动运行均没有最终答案。内容、完整性和引用判定一律为 \`not_assessable\`；这不等于答案内容错误。未运行的 36 项是 \`not_run\`，不混作已测失败。见 [逐项判定机器文件](adjudications.json)。
- 留出主通过率的冻结分母是 48 项；当前没有确认的严格通过样本，但因 36 项未运行、其余也无答案，本批不能得出有效的答案质量估计。D2 的答案级 AI 辅助源码审查、第二次复核和 D3 的逐题效果分析均未完成。

## 请求与上下文证据

- 开发批 48 次请求的解析诊断为 34 \`accepted\`、14 \`json_parse_recovered\`；\`finish_reason\` 为 44 \`stop\`、4 \`length\`。
- 留出批 88 次请求的解析诊断为 64 \`accepted\`、18 \`json_parse_recovered\`、3 \`invalid_action_json\`、3 \`empty_content\`；\`finish_reason\` 为 85 \`stop\`、3 \`length\`。
- 对全部 ${overall.modelRequests} 次请求核对了 Trace：\`context.built\` 与实际 \`model.requested\` Context 一一匹配；16 个 Session 的 Trace 均可加载并 Replay，Manifest/SQLite 一致性检查无问题。
- 未观察到可供答案引用核查的最终输出。因此不能用工具调用数、解析恢复数或 Trace 完整性替代答案评分。

## 预算与未知项

${batchLedgers}

账本数字是请求前的本地预留，不是扣款记录。Usage 按峰值未命中缓存价格估算，不知道缓存命中拆分；未查询供应商账单。没有对失败项重试，也没有在报告生成期间调用模型。

## 交付状态

- 本报告及 \`results.json\`、\`runs.csv\`、\`adjudications.json\` 均由 [生成脚本](../../../scripts/generate-real-eval-results.ts) 从冻结计划、运行诊断、Trace、SQLite、任务索引和 Rubric 计算；真实请求计数未手工填写。
- Fake Model 的 20 条固定样本 Demo 是自动化工程夹具，不是这次 DeepSeek 结果；本报告没有合并它的成功率。
- D1 未完成，D2/D3 无答案可评分/比较；留出批剩余项仍未运行。报告记录的是一次预算受限的部分实验，不代表项目总体能力，也不证明 A/B 改进。
- 先前的 [首个真实运行报告](../07-first-real-run-report.md) 仍记录 Pilot 历史；本报告补充后续多任务尝试，不覆盖旧工件。
`;
}

function formatUsd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`;
}

await main();
