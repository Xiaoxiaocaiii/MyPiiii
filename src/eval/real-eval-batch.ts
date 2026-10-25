import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { experimentConfigSchema, type ExperimentConfig } from '../core/config.js';
import {
  DeepSeekModelAdapter,
  estimateDeepSeekInputTokenUpperBound,
} from '../core/deepseek-model.js';
import type { ModelAdapter, ModelRequest } from '../core/model.js';
import { runAgent } from '../core/runtime.js';
import { createArtifactRun, type ArtifactRun } from '../observability/artifact-run.js';
import {
  createSqliteRunIndex,
  runIndexStatusSchema,
  type SqliteRunIndex,
} from '../observability/sqlite-run-index.js';
import { analyzeTraceConsistency } from '../observability/trace-consistency.js';
import { loadTraceRun } from '../observability/trace-loader.js';
import { replayLoadedTrace } from '../observability/trace-replay.js';
import { TraceRecorder } from '../observability/trace-recorder.js';
import {
  createModelAttemptDiagnosticsWriter,
  type ModelAttemptDiagnosticsWriter,
} from '../observability/model-attempt-diagnostics.js';
import { verifyRealEvalSnapshot, type RealEvalSnapshot } from './real-eval-snapshot.js';
import {
  createRealEvalSnapshotPreflight,
  createRealEvalToolRegistry,
  realEvalToolNames,
} from './real-eval-tools.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const splitSchema = z.enum(['development', 'holdout']);
const taskCategorySchema = z.enum([
  'control_flow_and_errors',
  'tool_permissions_and_input_boundaries',
  'context_and_feedback',
  'trace_and_evidence',
]);
const pricingSnapshotId = 'deepseek-flash-2026-10-24';
const peakInputCacheMissMicroUsdPerToken = 0.3;
const peakOutputMicroUsdPerToken = 1.2;

const budgetLedgerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: identifierSchema,
  authorizationId: identifierSchema,
  modelName: z.string().trim().min(1).max(256),
  pricingSnapshotId: z.literal(pricingSnapshotId),
  maxBudgetMicroUsd: z.number().int().positive(),
  reservedBudgetMicroUsd: z.number().int().nonnegative(),
  maxTotalModelRequests: z.number().int().positive().max(624),
  reservedModelRequests: z.number().int().nonnegative(),
  stopReason: z.enum(['budget_limit', 'request_limit']).nullable(),
  updatedAt: timestampSchema,
});

type BatchBudgetLedger = z.infer<typeof budgetLedgerSchema>;

const taskIndexEntrySchema = z.strictObject({
  taskId: z.string().regex(/^task-\d{3}$/),
  snapshotId: sha256Schema,
  taskTextPath: z.string().regex(/^task-\d{3}\.md$/),
  taskTextBytes: z.number().int().positive(),
  taskTextSha256: sha256Schema,
  category: taskCategorySchema,
  split: splitSchema,
  difficulty: z.enum(['low', 'medium', 'high']),
  difficultyRationale: z.string().min(1),
});

const taskIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: sha256Schema,
  hashAlgorithm: z.literal('sha256'),
  accessNote: z.string().min(1),
  tasks: z.array(taskIndexEntrySchema).length(12),
});

const batchVariantSchema = z.strictObject({
  variantId: z.enum(['A', 'B']),
  config: experimentConfigSchema,
  configHash: sha256Schema,
});

const artifactPathsSchema = z.strictObject({
  sessionDirectory: z.string().min(1),
  trace: z.string().min(1),
  manifest: z.string().min(1),
  finalOutput: z.string().min(1),
  failure: z.string().min(1),
  modelAttempts: z.string().min(1),
});

const offlineValidationSchema = z.strictObject({
  checkedAt: timestampSchema,
  traceLoaded: z.boolean(),
  replayed: z.boolean(),
  consistent: z.boolean(),
  issueCodes: z.array(identifierSchema),
  replayStatus: z.enum(['completed', 'failed']).nullable(),
  turnCount: z.number().int().nonnegative().nullable(),
  eventCount: z.number().int().nonnegative().nullable(),
  sqliteStatus: runIndexStatusSchema.nullable(),
  errorCode: identifierSchema.nullable(),
});

const batchItemSchema = z.strictObject({
  planItemId: identifierSchema,
  taskId: z.string().regex(/^task-\d{3}$/),
  taskHash: sha256Schema,
  split: splitSchema,
  snapshotId: sha256Schema,
  variantId: z.enum(['A', 'B']),
  repeat: z.number().int().positive().max(3),
  configHash: sha256Schema,
  sessionId: identifierSchema,
  status: z.enum(['planned', 'running', 'completed', 'failed', 'interrupted']),
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  runtimeStatus: z.enum(['completed', 'failed']).nullable(),
  runtimeFailureCode: identifierSchema.nullable(),
  failureCode: identifierSchema.nullable(),
  artifacts: artifactPathsSchema.nullable(),
  offlineValidation: offlineValidationSchema.nullable(),
});

export const realEvalBatchManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    batchId: identifierSchema,
    snapshotId: sha256Schema,
    split: splitSchema,
    taskIds: z
      .array(z.string().regex(/^task-\d{3}$/))
      .min(1)
      .max(12),
    repeats: z.number().int().positive().max(3),
    orderSeed: z.string().trim().min(1).max(128),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    planHash: sha256Schema,
    status: z.enum(['planned', 'running', 'completed', 'completed_with_failures', 'interrupted']),
    variants: z.array(batchVariantSchema).length(2),
    items: z.array(batchItemSchema).min(1).max(48),
  })
  .superRefine((manifest, context) => {
    if (manifest.variants[0]?.variantId !== 'A' || manifest.variants[1]?.variantId !== 'B') {
      context.addIssue({
        code: 'custom',
        message: 'Variants must be stored in A/B order',
        path: ['variants'],
      });
    }
    if (new Set(manifest.items.map((item) => item.planItemId)).size !== manifest.items.length) {
      context.addIssue({
        code: 'custom',
        message: 'Batch plan item IDs must be unique',
        path: ['items'],
      });
    }
    manifest.items.forEach((item, index) => {
      const isPlanned = item.status === 'planned';
      const isRunning = item.status === 'running';
      if (
        (isPlanned && (item.startedAt !== null || item.completedAt !== null)) ||
        (isRunning && (item.startedAt === null || item.completedAt !== null)) ||
        (!isPlanned && !isRunning && (item.startedAt === null || item.completedAt === null))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Batch item status and lifecycle timestamps are inconsistent',
          path: ['items', index],
        });
      }
    });
  });

export type RealEvalBatchManifest = z.infer<typeof realEvalBatchManifestSchema>;
export type RealEvalBatchItem = z.infer<typeof batchItemSchema>;

export const realEvalBatchAuthorizationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authorizationId: identifierSchema,
  batchId: identifierSchema,
  modelName: z.string().trim().min(1).max(256),
  pricingSnapshotId: z.literal(pricingSnapshotId),
  split: splitSchema,
  maxPlanItems: z.number().int().positive().max(48),
  maxTotalModelRequests: z.number().int().positive().max(624),
  maxBudgetUsd: z.number().min(0.01).max(1000),
  confirmedAt: timestampSchema,
});

export type RealEvalBatchAuthorization = z.infer<typeof realEvalBatchAuthorizationSchema>;

export type RealEvalBatchErrorCode =
  | 'BATCH_ALREADY_EXISTS'
  | 'BATCH_ARTIFACT_FAILED'
  | 'BATCH_AUTHORIZATION_INVALID'
  | 'BATCH_AUTHORIZATION_REQUIRED'
  | 'BATCH_BUDGET_LEDGER_INVALID'
  | 'BATCH_BUDGET_LIMIT_REACHED'
  | 'BATCH_CREDENTIALS_MISSING'
  | 'BATCH_INPUT_INVALID'
  | 'BATCH_LOCKED'
  | 'BATCH_MANIFEST_INVALID'
  | 'BATCH_NOT_PERSISTED'
  | 'BATCH_PLAN_CHANGED'
  | 'BATCH_RUN_FAILED'
  | 'BATCH_TASKS_INVALID'
  | 'BATCH_VARIANTS_INVALID';

const errorMessages: Record<RealEvalBatchErrorCode, string> = {
  BATCH_ALREADY_EXISTS: 'The real-evaluation batch already exists',
  BATCH_ARTIFACT_FAILED: 'The batch run artifacts could not be verified',
  BATCH_AUTHORIZATION_INVALID: 'The batch authorization does not cover this plan',
  BATCH_AUTHORIZATION_REQUIRED: 'Explicit batch authorization is required before model calls',
  BATCH_BUDGET_LEDGER_INVALID: 'The persisted batch budget ledger is invalid',
  BATCH_BUDGET_LIMIT_REACHED: 'The authorized request or USD budget limit was reached',
  BATCH_CREDENTIALS_MISSING: 'Set DEEPSEEK_API_KEY before executing an authorized batch',
  BATCH_INPUT_INVALID: 'The batch plan input is invalid',
  BATCH_LOCKED: 'Another process currently owns the batch execution lock',
  BATCH_MANIFEST_INVALID: 'The persisted batch manifest is invalid',
  BATCH_NOT_PERSISTED: 'Persist the dry-run plan before executing it',
  BATCH_PLAN_CHANGED: 'The task, snapshot, or persisted plan changed after planning',
  BATCH_RUN_FAILED: 'The batch could not be executed',
  BATCH_TASKS_INVALID: 'The selected task files do not match the frozen task index',
  BATCH_VARIANTS_INVALID: 'The A/B configurations differ outside the Context budget',
};

export class RealEvalBatchError extends Error {
  override readonly name = 'RealEvalBatchError';
  readonly code: RealEvalBatchErrorCode;

  constructor(code: RealEvalBatchErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface RealEvalBatchVariantInput {
  readonly variantId: 'A' | 'B';
  readonly config: ExperimentConfig;
}

export interface CreateRealEvalBatchPlanOptions {
  readonly repositoryRoot: string;
  readonly batchId: string;
  readonly snapshotId: string;
  readonly split: 'development' | 'holdout';
  readonly taskIds: readonly string[];
  readonly variants: readonly RealEvalBatchVariantInput[];
  readonly repeats: number;
  readonly orderSeed: string;
  readonly createdAt?: Date;
}

export interface RealEvalBatchPlan {
  readonly manifest: RealEvalBatchManifest;
  readonly dryRun: {
    readonly planItemCount: number;
    readonly maximumModelRequests: number;
    readonly rows: readonly {
      readonly planItemId: string;
      readonly taskId: string;
      readonly split: 'development' | 'holdout';
      readonly variantId: 'A' | 'B';
      readonly repeat: number;
      readonly sessionId: string;
      readonly configHash: string;
    }[];
  };
}

interface BatchPlanOptions extends CreateRealEvalBatchPlanOptions {
  readonly createdAt: Date;
}

interface BatchPlanContext {
  readonly options: BatchPlanOptions;
  readonly repositoryRoot: string;
  readonly taskTexts: ReadonlyMap<string, string>;
  readonly snapshot: RealEvalSnapshot;
  artifactDirectory: string | undefined;
  manifestPath: string | undefined;
}

const planContexts = new WeakMap<RealEvalBatchManifest, BatchPlanContext>();

export async function createRealEvalBatchPlan(
  options: CreateRealEvalBatchPlanOptions,
): Promise<RealEvalBatchPlan> {
  const validated = validatePlanOptions(options);
  const loaded = await loadFrozenInputs(validated);
  const variants = validateVariants(validated.variants);
  const taskRows = validated.taskIds.map((taskId) => {
    const task = loaded.taskIndex.tasks.find((entry) => entry.taskId === taskId);
    const taskText = loaded.taskTexts.get(taskId);
    if (task === undefined || taskText === undefined || task.split !== validated.split) {
      throw new RealEvalBatchError('BATCH_TASKS_INVALID');
    }
    return { task, taskText };
  });

  const items = shuffle(
    taskRows.flatMap(({ task }) =>
      Array.from({ length: validated.repeats }, (_, repeatIndex) =>
        variants.map((variant) =>
          createPlannedItem({
            batchId: validated.batchId,
            task,
            snapshotId: validated.snapshotId,
            variant,
            repeat: repeatIndex + 1,
          }),
        ),
      ).flat(),
    ),
    validated.orderSeed,
  );

  const createdAt = validated.createdAt.toISOString();
  const manifestWithoutHash = {
    schemaVersion: 1 as const,
    batchId: validated.batchId,
    snapshotId: validated.snapshotId,
    split: validated.split,
    taskIds: [...validated.taskIds],
    repeats: validated.repeats,
    orderSeed: validated.orderSeed,
    createdAt,
    updatedAt: createdAt,
    status: 'planned' as const,
    variants,
    items,
    planHash: '0'.repeat(64),
  };
  const manifest = realEvalBatchManifestSchema.parse({
    ...manifestWithoutHash,
    planHash: calculatePlanHash(manifestWithoutHash),
  });
  const dryRun = toDryRunSummary(manifest);
  deepFreeze(manifest);
  deepFreeze(dryRun);
  const plan: RealEvalBatchPlan = Object.freeze({ manifest, dryRun });
  planContexts.set(manifest, {
    options: validated,
    repositoryRoot: resolve(validated.repositoryRoot),
    taskTexts: loaded.taskTexts,
    snapshot: loaded.snapshot,
    artifactDirectory: undefined,
    manifestPath: undefined,
  });
  return plan;
}

export function formatRealEvalBatchDryRun(plan: RealEvalBatchPlan): string {
  requirePlanCapability(plan);
  return JSON.stringify(
    {
      dryRun: true,
      networkModelRequests: 0,
      ...plan.dryRun,
    },
    null,
    2,
  );
}

export async function persistRealEvalBatchPlan(
  plan: RealEvalBatchPlan,
  artifactDirectory: string,
): Promise<string> {
  const context = requirePlanCapability(plan);
  const root = resolve(artifactDirectory);
  const batchDirectory = join(root, 'batches', plan.manifest.batchId);
  const manifestPath = join(batchDirectory, 'batch-manifest.json');
  if (context.manifestPath !== undefined || artifactDirectory.trim().length === 0) {
    throw new RealEvalBatchError('BATCH_INPUT_INVALID');
  }
  await mkdir(dirname(batchDirectory), { recursive: true });
  try {
    await mkdir(batchDirectory);
  } catch {
    throw new RealEvalBatchError('BATCH_ALREADY_EXISTS');
  }
  await writeAtomicJson(manifestPath, plan.manifest, false);
  context.artifactDirectory = root;
  context.manifestPath = manifestPath;
  return manifestPath;
}

export interface RunRealEvalBatchOptions {
  readonly authorization?: unknown;
  readonly createAdapter?: (config: ExperimentConfig) => ModelAdapter;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onItemFinished?: (item: RealEvalBatchItem, totalItems: number) => void;
}

export async function runRealEvalBatch(
  plan: RealEvalBatchPlan,
  options: RunRealEvalBatchOptions = {},
): Promise<RealEvalBatchManifest> {
  const context = requirePlanCapability(plan);
  if (context.artifactDirectory === undefined || context.manifestPath === undefined) {
    throw new RealEvalBatchError('BATCH_NOT_PERSISTED');
  }
  const authorization = validateAuthorization(plan.manifest, options.authorization);
  const adapterFactory = resolveAdapterFactory(plan.manifest, options, authorization);
  return executePersistedBatch({
    manifest: plan.manifest,
    context,
    adapterFactory,
    authorization,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onItemFinished === undefined ? {} : { onItemFinished: options.onItemFinished }),
  });
}

export interface ResumeRealEvalBatchOptions extends RunRealEvalBatchOptions {
  readonly repositoryRoot: string;
  readonly artifactDirectory: string;
  readonly batchId: string;
}

export async function resumeRealEvalBatch(
  options: ResumeRealEvalBatchOptions,
): Promise<RealEvalBatchManifest> {
  const batchId = identifierSchema.safeParse(options.batchId);
  if (!batchId.success || options.artifactDirectory.trim().length === 0) {
    throw new RealEvalBatchError('BATCH_INPUT_INVALID');
  }
  const artifactDirectory = resolve(options.artifactDirectory);
  const manifestPath = join(artifactDirectory, 'batches', batchId.data, 'batch-manifest.json');
  const storedManifest = await readBatchManifest(manifestPath);
  if (storedManifest.batchId !== batchId.data) {
    throw new RealEvalBatchError('BATCH_MANIFEST_INVALID');
  }

  const plan = await createRealEvalBatchPlan({
    repositoryRoot: options.repositoryRoot,
    batchId: storedManifest.batchId,
    snapshotId: storedManifest.snapshotId,
    split: storedManifest.split,
    taskIds: storedManifest.taskIds,
    variants: storedManifest.variants.map(({ variantId, config }) => ({ variantId, config })),
    repeats: storedManifest.repeats,
    orderSeed: storedManifest.orderSeed,
    createdAt: new Date(storedManifest.createdAt),
  });
  if (plan.manifest.planHash !== storedManifest.planHash) {
    throw new RealEvalBatchError('BATCH_PLAN_CHANGED');
  }
  assertSamePlanItems(plan.manifest, storedManifest);

  const context = requirePlanCapability(plan);
  context.artifactDirectory = artifactDirectory;
  context.manifestPath = manifestPath;
  const hasPlannedItems = storedManifest.items.some((item) => item.status === 'planned');
  const authorization = hasPlannedItems
    ? validateAuthorization(plan.manifest, options.authorization)
    : undefined;
  const adapterFactory =
    authorization === undefined
      ? () => {
          throw new RealEvalBatchError('BATCH_AUTHORIZATION_REQUIRED');
        }
      : resolveAdapterFactory(plan.manifest, options, authorization);
  return executePersistedBatch({
    manifest: storedManifest,
    context,
    adapterFactory,
    authorization,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onItemFinished === undefined ? {} : { onItemFinished: options.onItemFinished }),
  });
}

function validatePlanOptions(options: CreateRealEvalBatchPlanOptions): BatchPlanOptions {
  const batchId = identifierSchema.safeParse(options.batchId);
  const snapshotId = sha256Schema.safeParse(options.snapshotId);
  const split = splitSchema.safeParse(options.split);
  const repeats = z.number().int().positive().max(3).safeParse(options.repeats);
  const orderSeed = z.string().trim().min(1).max(128).safeParse(options.orderSeed);
  const taskIds = z
    .array(z.string().regex(/^task-\d{3}$/))
    .min(1)
    .max(12)
    .safeParse(options.taskIds);
  const createdAt = options.createdAt ?? new Date();
  if (
    !batchId.success ||
    !snapshotId.success ||
    !split.success ||
    !repeats.success ||
    !orderSeed.success ||
    !taskIds.success ||
    new Set(taskIds.data).size !== taskIds.data.length ||
    !Number.isFinite(createdAt.getTime()) ||
    options.repositoryRoot.trim().length === 0 ||
    options.variants.length !== 2
  ) {
    throw new RealEvalBatchError('BATCH_INPUT_INVALID');
  }
  return {
    ...options,
    batchId: batchId.data,
    snapshotId: snapshotId.data,
    split: split.data,
    taskIds: taskIds.data,
    repeats: repeats.data,
    orderSeed: orderSeed.data,
    createdAt,
  };
}

async function loadFrozenInputs(options: BatchPlanOptions): Promise<{
  readonly taskIndex: z.infer<typeof taskIndexSchema>;
  readonly taskTexts: ReadonlyMap<string, string>;
  readonly snapshot: RealEvalSnapshot;
}> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const evalRoot = join(repositoryRoot, 'docs', 'research', 'real-eval');
  let taskIndexValue: unknown;
  let snapshotManifestValue: unknown;
  try {
    taskIndexValue = JSON.parse(
      await readFile(join(evalRoot, 'tasks', 'task-index.json'), 'utf8'),
    ) as unknown;
    snapshotManifestValue = JSON.parse(
      await readFile(join(evalRoot, 'snapshots', `${options.snapshotId}.manifest.json`), 'utf8'),
    ) as unknown;
  } catch {
    throw new RealEvalBatchError('BATCH_TASKS_INVALID');
  }
  const taskIndex = taskIndexSchema.safeParse(taskIndexValue);
  if (!taskIndex.success || taskIndex.data.snapshotId !== options.snapshotId) {
    throw new RealEvalBatchError('BATCH_TASKS_INVALID');
  }
  let snapshot: RealEvalSnapshot;
  try {
    snapshot = await verifyRealEvalSnapshot(
      join(evalRoot, 'snapshots', options.snapshotId),
      snapshotManifestValue,
      join(evalRoot, 'snapshots', `${options.snapshotId}.manifest.json`),
    );
  } catch {
    throw new RealEvalBatchError('BATCH_TASKS_INVALID');
  }
  const taskTexts = new Map<string, string>();
  for (const taskId of options.taskIds) {
    const entry = taskIndex.data.tasks.find((task) => task.taskId === taskId);
    if (
      entry === undefined ||
      entry.split !== options.split ||
      entry.snapshotId !== options.snapshotId ||
      entry.taskTextPath !== `${taskId}.md`
    ) {
      throw new RealEvalBatchError('BATCH_TASKS_INVALID');
    }
    let taskBytes: Buffer;
    try {
      taskBytes = await readFile(join(evalRoot, 'tasks', entry.taskTextPath));
    } catch {
      throw new RealEvalBatchError('BATCH_TASKS_INVALID');
    }
    if (
      taskBytes.byteLength !== entry.taskTextBytes ||
      sha256(taskBytes) !== entry.taskTextSha256
    ) {
      throw new RealEvalBatchError('BATCH_TASKS_INVALID');
    }
    const taskText = taskBytes.toString('utf8');
    if (taskText.trim().length === 0) {
      throw new RealEvalBatchError('BATCH_TASKS_INVALID');
    }
    taskTexts.set(taskId, taskText);
  }
  return { taskIndex: taskIndex.data, taskTexts, snapshot };
}

function validateVariants(
  inputs: readonly RealEvalBatchVariantInput[],
): RealEvalBatchManifest['variants'] {
  const parsed = inputs.map((variant) => ({
    variantId: variant.variantId,
    config: experimentConfigSchema.safeParse(variant.config),
  }));
  if (
    parsed.length !== 2 ||
    parsed[0]?.variantId !== 'A' ||
    parsed[1]?.variantId !== 'B' ||
    !parsed[0].config.success ||
    !parsed[1].config.success
  ) {
    throw new RealEvalBatchError('BATCH_VARIANTS_INVALID');
  }
  const configs = [parsed[0].config.data, parsed[1].config.data] as const;
  const [configA, configB] = configs;
  if (
    configA.scenarioId !== 'repo-qa' ||
    configB.scenarioId !== 'repo-qa' ||
    configA.model.provider !== 'deepseek' ||
    configB.model.provider !== 'deepseek' ||
    configA.model.name !== configB.model.name ||
    configA.configId !== configB.configId ||
    configA.context === undefined ||
    configB.context === undefined ||
    configA.context.maxCharacters !== 24_000 ||
    configB.context.maxCharacters !== 16_000 ||
    configA.runtime.maxTurns > 12 ||
    configB.runtime.maxTurns > 12 ||
    !sameToolAllowlist(configA.tools.enabled) ||
    !sameToolAllowlist(configB.tools.enabled) ||
    !safeRelativeArtifactDirectory(configA.artifacts.directory) ||
    !safeRelativeArtifactDirectory(configB.artifacts.directory) ||
    stableStringify(withoutContextBudget(configA)) !==
      stableStringify(withoutContextBudget(configB))
  ) {
    throw new RealEvalBatchError('BATCH_VARIANTS_INVALID');
  }
  return [
    { variantId: 'A', config: configA, configHash: hashJson(configA) },
    { variantId: 'B', config: configB, configHash: hashJson(configB) },
  ];
}

function sameToolAllowlist(names: readonly string[]): boolean {
  return (
    names.length === realEvalToolNames.length &&
    [...names].sort().every((name, index) => name === [...realEvalToolNames].sort()[index])
  );
}

function safeRelativeArtifactDirectory(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[a-zA-Z]:/.test(normalized) &&
    normalized.split('/').every((segment) => segment !== '..')
  );
}

function withoutContextBudget(config: ExperimentConfig): ExperimentConfig {
  if (config.context === undefined) {
    return config;
  }
  return {
    ...config,
    context: { ...config.context, maxCharacters: 0 },
  };
}

function createPlannedItem(options: {
  readonly batchId: string;
  readonly task: z.infer<typeof taskIndexEntrySchema>;
  readonly snapshotId: string;
  readonly variant: RealEvalBatchManifest['variants'][number];
  readonly repeat: number;
}): RealEvalBatchItem {
  const planItemId = `${options.task.taskId}-${options.variant.variantId}-r${options.repeat}`;
  const sessionId = `re-${sha256(`${options.batchId}/${planItemId}`).slice(0, 32)}`;
  return {
    planItemId,
    taskId: options.task.taskId,
    taskHash: options.task.taskTextSha256,
    split: options.task.split,
    snapshotId: options.snapshotId,
    variantId: options.variant.variantId,
    repeat: options.repeat,
    configHash: options.variant.configHash,
    sessionId,
    status: 'planned',
    startedAt: null,
    completedAt: null,
    runtimeStatus: null,
    runtimeFailureCode: null,
    failureCode: null,
    artifacts: null,
    offlineValidation: null,
  };
}

function shuffle<Value>(values: readonly Value[], seed: string): Value[] {
  const result = [...values];
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  const nextRandom = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function calculatePlanHash(
  manifest: Pick<
    RealEvalBatchManifest,
    'batchId' | 'snapshotId' | 'split' | 'taskIds' | 'repeats' | 'orderSeed' | 'variants' | 'items'
  >,
): string {
  return hashJson({
    batchId: manifest.batchId,
    snapshotId: manifest.snapshotId,
    split: manifest.split,
    taskIds: manifest.taskIds,
    repeats: manifest.repeats,
    orderSeed: manifest.orderSeed,
    variants: manifest.variants,
    items: manifest.items.map(planItemIdentity),
  });
}

function planItemIdentity(item: RealEvalBatchItem) {
  return {
    planItemId: item.planItemId,
    taskId: item.taskId,
    taskHash: item.taskHash,
    split: item.split,
    snapshotId: item.snapshotId,
    variantId: item.variantId,
    repeat: item.repeat,
    configHash: item.configHash,
    sessionId: item.sessionId,
  };
}

function assertSamePlanItems(current: RealEvalBatchManifest, stored: RealEvalBatchManifest): void {
  const currentItems = current.items.map(planItemIdentity);
  const storedItems = stored.items.map(planItemIdentity);
  if (stableStringify(currentItems) !== stableStringify(storedItems)) {
    throw new RealEvalBatchError('BATCH_PLAN_CHANGED');
  }
}

function toDryRunSummary(manifest: RealEvalBatchManifest): RealEvalBatchPlan['dryRun'] {
  const maxTurnsByVariant = new Map(
    manifest.variants.map(({ variantId, config }) => [variantId, config.runtime.maxTurns]),
  );
  return {
    planItemCount: manifest.items.length,
    maximumModelRequests: manifest.items.reduce(
      (total, item) => total + (maxTurnsByVariant.get(item.variantId) ?? 0),
      0,
    ),
    rows: manifest.items.map((item) => ({
      planItemId: item.planItemId,
      taskId: item.taskId,
      split: item.split,
      variantId: item.variantId,
      repeat: item.repeat,
      sessionId: item.sessionId,
      configHash: item.configHash,
    })),
  };
}

function validateAuthorization(
  manifest: RealEvalBatchManifest,
  input: unknown,
): RealEvalBatchAuthorization {
  if (input === undefined) {
    throw new RealEvalBatchError('BATCH_AUTHORIZATION_REQUIRED');
  }
  const authorization = realEvalBatchAuthorizationSchema.safeParse(input);
  if (!authorization.success) {
    throw new RealEvalBatchError('BATCH_AUTHORIZATION_INVALID');
  }
  const requiredModelRequests = toDryRunSummary(manifest).maximumModelRequests;
  if (
    authorization.data.batchId !== manifest.batchId ||
    authorization.data.modelName !== manifest.variants[0]?.config.model.name ||
    authorization.data.split !== manifest.split ||
    authorization.data.maxPlanItems < manifest.items.length ||
    authorization.data.maxTotalModelRequests < requiredModelRequests
  ) {
    throw new RealEvalBatchError('BATCH_AUTHORIZATION_INVALID');
  }
  return authorization.data;
}

async function createBatchBudgetGuard(options: {
  readonly path: string;
  readonly manifest: RealEvalBatchManifest;
  readonly authorization: RealEvalBatchAuthorization;
}): Promise<BatchBudgetGuard> {
  const maxBudgetMicroUsd = Math.floor(options.authorization.maxBudgetUsd * 1_000_000);
  let ledger: BatchBudgetLedger;
  try {
    const value = JSON.parse(await readFile(options.path, 'utf8')) as unknown;
    const parsed = budgetLedgerSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.batchId !== options.manifest.batchId ||
      parsed.data.authorizationId !== options.authorization.authorizationId ||
      parsed.data.modelName !== options.authorization.modelName ||
      parsed.data.pricingSnapshotId !== options.authorization.pricingSnapshotId ||
      parsed.data.maxBudgetMicroUsd !== maxBudgetMicroUsd ||
      parsed.data.maxTotalModelRequests !== options.authorization.maxTotalModelRequests ||
      parsed.data.reservedBudgetMicroUsd > parsed.data.maxBudgetMicroUsd ||
      parsed.data.reservedModelRequests > parsed.data.maxTotalModelRequests
    ) {
      throw new RealEvalBatchError('BATCH_BUDGET_LEDGER_INVALID');
    }
    ledger = parsed.data;
  } catch (error) {
    if (error instanceof RealEvalBatchError) {
      throw error;
    }
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RealEvalBatchError('BATCH_BUDGET_LEDGER_INVALID');
    }
    if (options.manifest.items.some((item) => item.status !== 'planned')) {
      throw new RealEvalBatchError('BATCH_BUDGET_LEDGER_INVALID');
    }
    ledger = budgetLedgerSchema.parse({
      schemaVersion: 1,
      batchId: options.manifest.batchId,
      authorizationId: options.authorization.authorizationId,
      modelName: options.authorization.modelName,
      pricingSnapshotId: options.authorization.pricingSnapshotId,
      maxBudgetMicroUsd,
      reservedBudgetMicroUsd: 0,
      maxTotalModelRequests: options.authorization.maxTotalModelRequests,
      reservedModelRequests: 0,
      stopReason: null,
      updatedAt: new Date().toISOString(),
    });
    await writeAtomicJson(options.path, ledger, false);
  }

  return {
    get stopped() {
      return ledger.stopReason !== null;
    },
    async reserve(request) {
      if (ledger.stopReason !== null) {
        throw new RealEvalBatchError('BATCH_BUDGET_LIMIT_REACHED');
      }
      const cost = estimateRequestCostUpperBoundMicroUsd(request);
      const requestLimitReached = ledger.reservedModelRequests >= ledger.maxTotalModelRequests;
      const budgetLimitReached = ledger.reservedBudgetMicroUsd + cost > ledger.maxBudgetMicroUsd;
      if (requestLimitReached || budgetLimitReached) {
        ledger = budgetLedgerSchema.parse({
          ...ledger,
          stopReason: requestLimitReached ? 'request_limit' : 'budget_limit',
          updatedAt: new Date().toISOString(),
        });
        await writeAtomicJson(options.path, ledger, true);
        throw new RealEvalBatchError('BATCH_BUDGET_LIMIT_REACHED');
      }
      ledger = budgetLedgerSchema.parse({
        ...ledger,
        reservedBudgetMicroUsd: ledger.reservedBudgetMicroUsd + cost,
        reservedModelRequests: ledger.reservedModelRequests + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeAtomicJson(options.path, ledger, true);
    },
  };
}

function estimateRequestCostUpperBoundMicroUsd(request: ModelRequest): number {
  const inputTokenUpperBound = estimateDeepSeekInputTokenUpperBound(request);
  const inputCostMicroUsd = Math.ceil(inputTokenUpperBound * peakInputCacheMissMicroUsdPerToken);
  const outputCostMicroUsd = Math.ceil(request.model.maxOutputTokens * peakOutputMicroUsdPerToken);
  return inputCostMicroUsd + outputCostMicroUsd;
}

function resolveAdapterFactory(
  manifest: RealEvalBatchManifest,
  options: RunRealEvalBatchOptions,
  authorization: RealEvalBatchAuthorization,
): (config: ExperimentConfig) => ModelAdapter {
  const apiKey = (options.apiKey ?? process.env.DEEPSEEK_API_KEY)?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new RealEvalBatchError('BATCH_CREDENTIALS_MISSING');
  }
  if (authorization.modelName !== manifest.variants[0]?.config.model.name) {
    throw new RealEvalBatchError('BATCH_AUTHORIZATION_INVALID');
  }
  if (options.createAdapter !== undefined) {
    return options.createAdapter;
  }
  if (authorization.modelName !== 'deepseek-flash') {
    throw new RealEvalBatchError('BATCH_AUTHORIZATION_INVALID');
  }
  return () =>
    new DeepSeekModelAdapter({
      apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
}

function requirePlanCapability(plan: RealEvalBatchPlan): BatchPlanContext {
  const context = planContexts.get(plan.manifest);
  if (context === undefined) {
    throw new RealEvalBatchError('BATCH_INPUT_INVALID');
  }
  return context;
}

function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

interface ExecuteBatchOptions {
  readonly manifest: RealEvalBatchManifest;
  readonly context: BatchPlanContext;
  readonly adapterFactory: (config: ExperimentConfig) => ModelAdapter;
  readonly authorization: RealEvalBatchAuthorization | undefined;
  readonly signal?: AbortSignal;
  readonly onItemFinished?: (item: RealEvalBatchItem, totalItems: number) => void;
}

interface BatchBudgetGuard {
  readonly stopped: boolean;
  reserve(request: ModelRequest): Promise<void>;
}

interface BatchLock {
  readonly path: string;
  readonly token: string;
}

async function executePersistedBatch(options: ExecuteBatchOptions): Promise<RealEvalBatchManifest> {
  const { context } = options;
  if (context.artifactDirectory === undefined || context.manifestPath === undefined) {
    throw new RealEvalBatchError('BATCH_NOT_PERSISTED');
  }
  const lock = await acquireBatchLock(join(dirname(context.manifestPath), 'execution.lock'));
  let runIndex: SqliteRunIndex | undefined;
  try {
    const stored = await readBatchManifest(context.manifestPath);
    if (
      stored.batchId !== options.manifest.batchId ||
      stored.planHash !== options.manifest.planHash
    ) {
      throw new RealEvalBatchError('BATCH_PLAN_CHANGED');
    }

    const refreshedPlan = await createRealEvalBatchPlan(context.options);
    if (refreshedPlan.manifest.planHash !== stored.planHash) {
      throw new RealEvalBatchError('BATCH_PLAN_CHANGED');
    }
    assertSamePlanItems(refreshedPlan.manifest, stored);
    const refreshedContext = requirePlanCapability(refreshedPlan);
    refreshedContext.artifactDirectory = context.artifactDirectory;
    refreshedContext.manifestPath = context.manifestPath;

    let current = realEvalBatchManifestSchema.parse({
      ...refreshedPlan.manifest,
      ...stored,
      variants: refreshedPlan.manifest.variants,
      items: stored.items,
    });
    current = markAbandonedItemsInterrupted(current);
    current = withBatchStatus(current, new Date().toISOString());
    await writeAtomicJson(context.manifestPath, current, true);

    const planned = current.items.filter((item) => item.status === 'planned');
    if (planned.length === 0) {
      return current;
    }
    if (options.authorization === undefined) {
      throw new RealEvalBatchError('BATCH_AUTHORIZATION_REQUIRED');
    }

    await mkdir(context.artifactDirectory, { recursive: true });
    const budgetGuard = await createBatchBudgetGuard({
      path: join(dirname(context.manifestPath), 'budget-ledger.json'),
      manifest: current,
      authorization: options.authorization,
    });
    if (budgetGuard.stopped) {
      current = withBatchStatus(current, new Date().toISOString());
      await writeAtomicJson(context.manifestPath, current, true);
      return current;
    }
    try {
      runIndex = createSqliteRunIndex({
        path: join(context.artifactDirectory, 'real-eval-runs.sqlite'),
      });
    } catch {
      throw new RealEvalBatchError('BATCH_ARTIFACT_FAILED');
    }

    const configByVariant = new Map(
      current.variants.map((variant) => [variant.variantId, variant.config]),
    );
    const budgetStopController = new AbortController();
    const batchSignal =
      options.signal === undefined
        ? budgetStopController.signal
        : AbortSignal.any([options.signal, budgetStopController.signal]);
    current = realEvalBatchManifestSchema.parse({
      ...current,
      status: 'running',
      updatedAt: new Date().toISOString(),
    });
    await writeAtomicJson(context.manifestPath, current, true);

    for (const plannedItem of planned) {
      if (batchSignal.aborted) {
        break;
      }
      const item = current.items.find((entry) => entry.planItemId === plannedItem.planItemId);
      const config = configByVariant.get(plannedItem.variantId);
      if (item === undefined || config === undefined || item.status !== 'planned') {
        throw new RealEvalBatchError('BATCH_MANIFEST_INVALID');
      }

      const startedAt = new Date().toISOString();
      const runningItem = { ...item, status: 'running' as const, startedAt };
      current = replaceBatchItem(current, runningItem, startedAt);
      await writeAtomicJson(context.manifestPath, current, true);

      const outcome = await executeBatchItem({
        item: runningItem,
        config,
        context: refreshedContext,
        runIndex,
        adapterFactory: options.adapterFactory,
        budgetGuard,
        onBudgetGuardFailure: () => budgetStopController.abort(),
        signal: batchSignal,
      });
      current = replaceBatchItem(current, outcome, new Date().toISOString());
      await writeAtomicJson(context.manifestPath, current, true);
      try {
        options.onItemFinished?.(outcome, current.items.length);
      } catch {
        // Progress reporting must not change the persisted evaluation outcome.
      }
    }

    current = withBatchStatus(current, new Date().toISOString());
    await writeAtomicJson(context.manifestPath, current, true);
    return current;
  } finally {
    try {
      runIndex?.close();
    } finally {
      await releaseBatchLock(lock);
    }
  }
}

function markAbandonedItemsInterrupted(manifest: RealEvalBatchManifest): RealEvalBatchManifest {
  const now = new Date().toISOString();
  return realEvalBatchManifestSchema.parse({
    ...manifest,
    items: manifest.items.map((item) =>
      item.status === 'running'
        ? {
            ...item,
            status: 'interrupted',
            completedAt: now,
            failureCode: 'PROCESS_INTERRUPTED',
          }
        : item,
    ),
    updatedAt: now,
  });
}

function withBatchStatus(
  manifest: RealEvalBatchManifest,
  updatedAt: string,
): RealEvalBatchManifest {
  const statuses = manifest.items.map((item) => item.status);
  let status: RealEvalBatchManifest['status'];
  if (statuses.some((value) => value === 'running')) {
    status = 'running';
  } else if (statuses.some((value) => value === 'planned')) {
    status = 'interrupted';
  } else if (statuses.some((value) => value === 'interrupted')) {
    status = 'interrupted';
  } else if (statuses.some((value) => value === 'failed')) {
    status = 'completed_with_failures';
  } else {
    status = 'completed';
  }
  return realEvalBatchManifestSchema.parse({ ...manifest, status, updatedAt });
}

function replaceBatchItem(
  manifest: RealEvalBatchManifest,
  replacement: RealEvalBatchItem,
  updatedAt: string,
): RealEvalBatchManifest {
  return realEvalBatchManifestSchema.parse({
    ...manifest,
    items: manifest.items.map((item) =>
      item.planItemId === replacement.planItemId ? replacement : item,
    ),
    updatedAt,
  });
}

interface ExecuteBatchItemOptions {
  readonly item: RealEvalBatchItem;
  readonly config: ExperimentConfig;
  readonly context: BatchPlanContext;
  readonly runIndex: SqliteRunIndex;
  readonly adapterFactory: (config: ExperimentConfig) => ModelAdapter;
  readonly budgetGuard: BatchBudgetGuard;
  readonly onBudgetGuardFailure: () => void;
  readonly signal?: AbortSignal;
}

async function executeBatchItem(options: ExecuteBatchItemOptions): Promise<RealEvalBatchItem> {
  const { item, config, context, runIndex } = options;
  const createdAt = new Date(item.startedAt ?? Date.now());
  let artifact: ArtifactRun | undefined;
  let diagnosticsWriter: ModelAttemptDiagnosticsWriter | undefined;
  let artifactFinalized = false;
  let indexCreated = false;
  let runtimeStatus: 'completed' | 'failed' | null = null;
  let runtimeFailureCode: string | null = null;
  let artifacts: RealEvalBatchItem['artifacts'] = null;
  let offlineValidation: RealEvalBatchItem['offlineValidation'] = null;

  try {
    artifact = await createArtifactRun({
      directory: context.artifactDirectory!,
      sessionId: item.sessionId,
      config,
      createdAt,
      provenance: {
        schemaVersion: 1,
        sourceSnapshot: {
          revision: context.snapshot.manifest.baseRevision,
          files: context.snapshot.manifest.files.map(({ path, sha256: fileHash }) => ({
            path,
            sha256: fileHash,
          })),
        },
        redaction: {
          schemaVersion: 1,
          toolCallArguments: 'redacted',
          sensitiveFields: 'rejected',
          arbitraryText: 'not_scanned',
        },
      },
    });
    artifacts = describeBatchArtifacts(context.artifactDirectory!, artifact);
    diagnosticsWriter = await createModelAttemptDiagnosticsWriter(
      join(artifact.paths.sessionDirectory, 'model-attempts.jsonl'),
    );

    runIndex.createRun({
      schemaVersion: 1,
      sessionId: item.sessionId,
      configId: config.configId,
      scenarioId: config.scenarioId,
      model: { provider: config.model.provider, name: config.model.name },
      createdAt: createdAt.toISOString(),
      artifacts: {
        manifest: relativeArtifactPath(context.artifactDirectory!, artifact.paths.manifest),
        trace: relativeArtifactPath(context.artifactDirectory!, artifact.paths.trace),
        finalOutput: relativeArtifactPath(context.artifactDirectory!, artifact.paths.finalOutput),
      },
    });
    indexCreated = true;

    const taskText = context.taskTexts.get(item.taskId);
    if (taskText === undefined || sha256(Buffer.from(taskText, 'utf8')) !== item.taskHash) {
      throw new RealEvalBatchError('BATCH_PLAN_CHANGED');
    }
    const runtimeResult = await runAgent(
      {
        schemaVersion: 1,
        sessionId: item.sessionId,
        inputMessage: taskText,
        config,
      },
      options.adapterFactory(config),
      {
        trace: {
          recorder: new TraceRecorder({ sessionId: item.sessionId, sink: artifact.trace }),
        },
        tools: { registry: createRealEvalToolRegistry(context.snapshot) },
        beforeModelRequest: async (request, signal) => {
          await createRealEvalSnapshotPreflight(context.snapshot)(request, signal);
          try {
            await options.budgetGuard.reserve(request);
          } catch (error) {
            options.onBudgetGuardFailure();
            throw error;
          }
        },
        onModelAttemptDiagnostic: (diagnostic) => diagnosticsWriter!.append(diagnostic),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    await diagnosticsWriter.close();
    diagnosticsWriter = undefined;
    runtimeStatus = runtimeResult.status;
    runtimeFailureCode = runtimeResult.status === 'failed' ? runtimeResult.error.code : null;

    const completedAt = new Date().toISOString();
    const manifest = await artifact.finalize({
      status: runtimeResult.status,
      completedAt: new Date(completedAt),
      finalOutput:
        runtimeResult.status === 'completed'
          ? runtimeResult.finalOutput
          : { error: runtimeResult.error },
    });
    artifactFinalized = true;
    runIndex.finishRun({
      schemaVersion: 1,
      sessionId: item.sessionId,
      status: manifest.status,
      completedAt: manifest.completedAt,
    });
    const indexedRun = runIndex.getRun(item.sessionId);
    if (indexedRun === undefined) {
      throw new RealEvalBatchError('BATCH_ARTIFACT_FAILED');
    }
    const loaded = await loadTraceRun({ sessionDirectory: artifact.paths.sessionDirectory });
    const consistency = analyzeTraceConsistency(loaded, { sqliteStatus: indexedRun.status });
    const replay = replayLoadedTrace(loaded);
    offlineValidation = offlineValidationSchema.parse({
      checkedAt: new Date().toISOString(),
      traceLoaded: true,
      replayed: true,
      consistent: consistency.consistent,
      issueCodes: consistency.issues.map((issue) => issue.code),
      replayStatus: replay.status,
      turnCount: replay.turns.length,
      eventCount: loaded.events.length,
      sqliteStatus: indexedRun.status,
      errorCode: null,
    });
    if (!consistency.consistent) {
      throw new RealEvalBatchError('BATCH_ARTIFACT_FAILED');
    }

    const budgetStoppedRuntime =
      runtimeResult.status === 'failed' &&
      runtimeResult.error.code === 'ABORTED' &&
      options.budgetGuard.stopped;
    return {
      ...item,
      status:
        runtimeResult.status === 'completed'
          ? 'completed'
          : budgetStoppedRuntime
            ? 'interrupted'
            : 'failed',
      completedAt,
      runtimeStatus,
      runtimeFailureCode,
      failureCode: budgetStoppedRuntime ? 'BATCH_BUDGET_LIMIT_REACHED' : runtimeFailureCode,
      artifacts,
      offlineValidation,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    await diagnosticsWriter?.close().catch(() => undefined);
    if (artifact !== undefined && !artifactFinalized) {
      await artifact.abort(stableErrorCode(error)).catch(() => undefined);
      artifacts = describeBatchArtifacts(context.artifactDirectory!, artifact);
    }
    if (indexCreated) {
      try {
        if (runIndex.getRun(item.sessionId)?.status === 'running') {
          runIndex.finishRun({
            schemaVersion: 1,
            sessionId: item.sessionId,
            status: 'failed',
            completedAt: completionTime(createdAt),
          });
        }
      } catch {
        // The item remains failed in the batch ledger; preserve the original failure code.
      }
    }
    if (offlineValidation === null) {
      offlineValidation = offlineValidationSchema.parse({
        checkedAt: completedAt,
        traceLoaded: false,
        replayed: false,
        consistent: false,
        issueCodes: [],
        replayStatus: null,
        turnCount: null,
        eventCount: null,
        sqliteStatus: indexCreated ? (runIndex.getRun(item.sessionId)?.status ?? null) : null,
        errorCode: stableErrorCode(error),
      });
    }
    return {
      ...item,
      status: 'failed',
      completedAt,
      runtimeStatus,
      runtimeFailureCode,
      failureCode: stableErrorCode(error),
      artifacts,
      offlineValidation,
    };
  }
}

function describeBatchArtifacts(
  rootDirectory: string,
  artifact: ArtifactRun,
): RealEvalBatchItem['artifacts'] {
  return {
    sessionDirectory: relativeArtifactPath(rootDirectory, artifact.paths.sessionDirectory),
    trace: relativeArtifactPath(rootDirectory, artifact.paths.trace),
    manifest: relativeArtifactPath(rootDirectory, artifact.paths.manifest),
    finalOutput: relativeArtifactPath(rootDirectory, artifact.paths.finalOutput),
    failure: relativeArtifactPath(rootDirectory, artifact.paths.failure),
    modelAttempts: relativeArtifactPath(
      rootDirectory,
      join(artifact.paths.sessionDirectory, 'model-attempts.jsonl'),
    ),
  };
}

function relativeArtifactPath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

function completionTime(createdAt: Date): string {
  return new Date(Math.max(Date.now(), createdAt.getTime())).toISOString();
}

function stableErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    identifierSchema.safeParse(error.code).success
  ) {
    return error.code;
  }
  return 'BATCH_RUN_FAILED';
}

interface BatchLockFile {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly createdAt: string;
}

async function acquireBatchLock(path: string): Promise<BatchLock> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const value: BatchLockFile = {
    schemaVersion: 1,
    pid: process.pid,
    host: hostname(),
    token,
    createdAt: new Date().toISOString(),
  };
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    return { path, token };
  } catch (error) {
    if (!isExistsError(error)) {
      throw new RealEvalBatchError('BATCH_RUN_FAILED');
    }
  }

  let existing: BatchLockFile;
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as BatchLockFile;
  } catch {
    throw new RealEvalBatchError('BATCH_LOCKED');
  }
  if (
    existing.schemaVersion !== 1 ||
    existing.host !== hostname() ||
    !Number.isInteger(existing.pid) ||
    processIsAlive(existing.pid)
  ) {
    throw new RealEvalBatchError('BATCH_LOCKED');
  }
  await rm(path, { force: true });
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    return { path, token };
  } catch {
    throw new RealEvalBatchError('BATCH_LOCKED');
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function releaseBatchLock(lock: BatchLock): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(lock.path, 'utf8')) as BatchLockFile;
    if (existing.token === lock.token) {
      await rm(lock.path, { force: true });
    }
  } catch {
    // A stale or externally removed lock is not replaced or recreated here.
  }
}

async function readBatchManifest(path: string): Promise<RealEvalBatchManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new RealEvalBatchError('BATCH_MANIFEST_INVALID');
  }
  const parsed = realEvalBatchManifestSchema.safeParse(value);
  if (!parsed.success || calculatePlanHash(parsed.data) !== parsed.data.planHash) {
    throw new RealEvalBatchError('BATCH_MANIFEST_INVALID');
  }
  return parsed.data;
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  replaceExisting: boolean,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!replaceExisting) {
      try {
        await lstat(path);
        throw new RealEvalBatchError('BATCH_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof RealEvalBatchError) {
          throw error;
        }
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof RealEvalBatchError) {
      throw error;
    }
    throw new RealEvalBatchError('BATCH_RUN_FAILED');
  }
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
