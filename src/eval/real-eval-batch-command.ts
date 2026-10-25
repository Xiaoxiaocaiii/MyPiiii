import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExperimentConfig } from '../core/config.js';
import {
  createRealEvalBatchPlan,
  formatRealEvalBatchDryRun,
  persistRealEvalBatchPlan,
  realEvalBatchAuthorizationSchema,
  resumeRealEvalBatch,
  type RealEvalBatchAuthorization,
  type RealEvalBatchVariantInput,
} from './real-eval-batch.js';
import { realEvalToolNames } from './real-eval-tools.js';

const defaultSnapshotId = '62cded2474cd1f57d3e1387bd12889e049e6e782a968525ee6ead018b7c5d0d3';

export interface RealEvalBatchCommandOptions {
  readonly repositoryRoot?: string;
}

export async function runRealEvalBatchCommand(
  args: readonly string[],
  write: (message: string) => void,
  options: RealEvalBatchCommandOptions = {},
): Promise<void> {
  const [action, ...rawOptions] = args;
  if (action === '--help' || action === undefined) {
    write(realEvalBatchCommandHelp);
    return;
  }
  const parsed = parseOptions(rawOptions);
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());

  if (action === 'plan') {
    assertKnownOptions(parsed, [
      '--batch-id',
      '--model',
      '--split',
      '--repeats',
      '--task-ids',
      '--seed',
      '--snapshot-id',
      '--artifact-root',
    ]);
    const batchId = requireOption(parsed, '--batch-id');
    const modelName = requireOption(parsed, '--model');
    const splitValue = requireOption(parsed, '--split');
    if (splitValue !== 'development' && splitValue !== 'holdout') {
      throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
    }
    const repeats = Number(requireOption(parsed, '--repeats'));
    if (!Number.isSafeInteger(repeats)) {
      throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
    }
    const taskIds = requireOption(parsed, '--task-ids').split(',');
    const variants = createVariants(modelName);
    const plan = await createRealEvalBatchPlan({
      repositoryRoot,
      batchId,
      snapshotId: parsed.get('--snapshot-id') ?? defaultSnapshotId,
      split: splitValue,
      taskIds,
      variants,
      repeats,
      orderSeed: requireOption(parsed, '--seed'),
    });
    const manifestPath = await persistRealEvalBatchPlan(
      plan,
      requireOption(parsed, '--artifact-root'),
    );
    write(formatRealEvalBatchDryRun(plan));
    write(`Plan persisted: ${manifestPath}`);
    return;
  }

  if (action === 'run') {
    assertKnownOptions(parsed, [
      '--batch-id',
      '--artifact-root',
      '--authorization',
      '--confirm-paid-batch',
    ]);
    if (!parsed.has('--confirm-paid-batch')) {
      throw new RealEvalBatchCommandError('BATCH_AUTHORIZATION_REQUIRED');
    }
    const batchId = requireOption(parsed, '--batch-id');
    const artifactDirectory = requireOption(parsed, '--artifact-root');
    const authorizationPath = resolve(requireOption(parsed, '--authorization'));
    let authorization: RealEvalBatchAuthorization;
    try {
      authorization = realEvalBatchAuthorizationSchema.parse(
        JSON.parse(await readFile(authorizationPath, 'utf8')) as unknown,
      );
    } catch {
      throw new RealEvalBatchCommandError('BATCH_AUTHORIZATION_INVALID');
    }
    let processedCount = 0;
    const result = await resumeRealEvalBatch({
      repositoryRoot,
      artifactDirectory,
      batchId,
      authorization,
      onItemFinished: (item, totalItems) => {
        processedCount += 1;
        write(
          `${item.status} ${item.planItemId} (processed ${processedCount}; plan ${totalItems})`,
        );
      },
    });
    write(`Batch ${result.batchId}: ${result.status}`);
    write(
      `Items: completed=${result.items.filter(({ status }) => status === 'completed').length}, failed=${result.items.filter(({ status }) => status === 'failed').length}, interrupted=${result.items.filter(({ status }) => status === 'interrupted').length}, planned=${result.items.filter(({ status }) => status === 'planned').length}`,
    );
    return;
  }

  throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
}

export class RealEvalBatchCommandError extends Error {
  override readonly name = 'RealEvalBatchCommandError';
  readonly code:
    'BATCH_AUTHORIZATION_INVALID' | 'BATCH_AUTHORIZATION_REQUIRED' | 'BATCH_INPUT_INVALID';

  constructor(code: RealEvalBatchCommandError['code']) {
    super(code);
    this.code = code;
  }
}

export const realEvalBatchCommandHelp = [
  'Usage:',
  '  agent-harness real-eval-batch plan --batch-id ID --model MODEL --split development|holdout',
  '    --task-ids task-001,task-004 --repeats N --seed SEED --artifact-root DIR',
  '  agent-harness real-eval-batch run --batch-id ID --artifact-root DIR',
  '    --authorization FILE --confirm-paid-batch',
  '',
  'The plan action validates and persists a zero-network dry run.',
  'The run action requires a separate authorization file and explicit paid-batch confirmation.',
].join('\n');

function parseOptions(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === undefined || !name.startsWith('--') || parsed.has(name)) {
      throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
    }
    if (name === '--confirm-paid-batch') {
      parsed.set(name, '');
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
    }
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function requireOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
  }
  return value;
}

function assertKnownOptions(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  if ([...options.keys()].some((option) => !allowed.includes(option))) {
    throw new RealEvalBatchCommandError('BATCH_INPUT_INVALID');
  }
}

function createVariants(modelName: string): readonly RealEvalBatchVariantInput[] {
  const makeConfig = (variant: 'A' | 'B'): ExperimentConfig => ({
    schemaVersion: 1,
    configId: 'real-eval-context-ab',
    scenarioId: 'repo-qa',
    model: {
      provider: 'deepseek',
      name: modelName,
      temperature: 0,
      maxOutputTokens: 4096,
    },
    runtime: { maxTurns: 12, timeoutMs: 120_000 },
    context: {
      maxCharacters: variant === 'A' ? 24_000 : 16_000,
      recentTurns: 4,
      observationMaxCharacters: 5000,
    },
    tools: { enabled: [...realEvalToolNames] },
    artifacts: { directory: './artifacts/real-eval-runs' },
  });
  return [
    { variantId: 'A', config: makeConfig('A') },
    { variantId: 'B', config: makeConfig('B') },
  ];
}
