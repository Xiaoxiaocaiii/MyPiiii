import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import { z } from 'zod';

import { runAgent, type RuntimeResult } from '../core/runtime.js';
import type { ExperimentConfig } from '../core/config.js';
import type { ModelAdapter } from '../core/model.js';
import type { ToolRegistry } from '../core/tool-registry.js';
import { createArtifactRun } from '../observability/artifact-run.js';
import { replayTraceRun } from '../observability/trace-replay.js';
import { TraceReplayError } from '../observability/trace-replay.js';
import { createSqliteRunIndex, type SqliteRunIndex } from '../observability/sqlite-run-index.js';
import type { CreateSqliteRunIndexOptions } from '../observability/sqlite-run-index.js';
import { TraceRecorder } from '../observability/trace-recorder.js';
import {
  evalDatasetSchema,
  evalExperimentIdentitySchema,
  evalSampleResultSchema,
  parseEvalSampleResult,
  type EvalCase,
  type EvalDataset,
  type EvalExperimentIdentity,
  type EvalSampleResult,
} from './eval-contracts.js';
import { adaptRepoQaInput } from '../scenarios/repo-qa.js';
import { scoreEvalCase } from './deterministic-scorer.js';

export const evalRunResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experiment: evalExperimentIdentitySchema,
  samples: z.array(evalSampleResultSchema).min(1),
});

export type EvalRunResult = {
  readonly schemaVersion: 1;
  readonly experiment: EvalExperimentIdentity;
  readonly samples: readonly EvalSampleResult[];
};

export type EvalRunnerErrorCode =
  | 'EVAL_RUNNER_DATASET_INVALID'
  | 'EVAL_RUNNER_SCENARIO_UNSUPPORTED'
  | 'EVAL_RUNNER_EXECUTION_FAILED'
  | 'EVAL_RUNNER_ARTIFACT_FAILED';

const errorMessages: Record<EvalRunnerErrorCode, string> = {
  EVAL_RUNNER_DATASET_INVALID: 'The evaluation dataset is invalid',
  EVAL_RUNNER_SCENARIO_UNSUPPORTED: 'The evaluation scenario is not supported',
  EVAL_RUNNER_EXECUTION_FAILED: 'The evaluation sample could not be executed',
  EVAL_RUNNER_ARTIFACT_FAILED: 'The evaluation artifact could not be published',
};

export class EvalRunnerError extends Error {
  override readonly name = 'EvalRunnerError';
  readonly code: EvalRunnerErrorCode;

  constructor(code: EvalRunnerErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface EvalRunnerOptions {
  readonly dataset: unknown;
  readonly experiment: EvalExperimentIdentity;
  readonly config: ExperimentConfig;
  readonly artifactDirectory: string;
  readonly runIndex?: SqliteRunIndex;
  readonly createRunIndex?: (options: CreateSqliteRunIndexOptions) => SqliteRunIndex;
  readonly createAdapter: (evalCase: EvalCase, config: ExperimentConfig) => ModelAdapter;
  readonly createTools?: (evalCase: EvalCase, config: ExperimentConfig) => ToolRegistry | undefined;
  readonly createSessionId?: (evalCase: EvalCase, index: number) => string;
  readonly createdAt?: Date;
}

export async function runEvaluation(options: EvalRunnerOptions): Promise<EvalRunResult> {
  const dataset = evalDatasetSchema.safeParse(options.dataset);
  if (!dataset.success) {
    throw new EvalRunnerError('EVAL_RUNNER_DATASET_INVALID');
  }
  if (
    dataset.data.scenarioId !== options.experiment.scenarioId ||
    dataset.data.scenarioVersion !== options.experiment.scenarioVersion ||
    options.config.scenarioId !== dataset.data.scenarioId
  ) {
    throw new EvalRunnerError('EVAL_RUNNER_SCENARIO_UNSUPPORTED');
  }

  const experiment = evalExperimentIdentitySchema.parse(options.experiment);
  const runIndex =
    options.runIndex ??
    (options.createRunIndex ?? createSqliteRunIndex)({
      path: `${options.artifactDirectory}/eval-runs.sqlite`,
    });
  const samples: EvalSampleResult[] = [];

  for (const [index, evalCase] of dataset.data.cases.entries()) {
    samples.push(
      await runSample({
        ...options,
        dataset: dataset.data,
        experiment,
        evalCase,
        index,
        runIndex,
      }),
    );
  }

  return {
    schemaVersion: 1,
    experiment,
    samples,
  };
}

interface RunSampleOptions extends EvalRunnerOptions {
  readonly dataset: EvalDataset;
  readonly experiment: EvalExperimentIdentity;
  readonly evalCase: EvalCase;
  readonly index: number;
  readonly runIndex: SqliteRunIndex;
}

async function runSample(options: RunSampleOptions): Promise<EvalSampleResult> {
  const sessionId =
    options.createSessionId?.(options.evalCase, options.index) ??
    `eval-${options.experiment.experimentId}-${String(options.index + 1).padStart(2, '0')}-${randomUUID().slice(0, 8)}`;
  const config = {
    ...options.config,
    artifacts: { directory: options.artifactDirectory },
  };
  const createdAt = options.createdAt ?? new Date();
  const artifact = await createArtifactRun({
    directory: options.artifactDirectory,
    sessionId,
    config,
    createdAt,
  });
  const rootDirectory = artifact.paths.rootDirectory;
  const relativeTracePath = normalizePath(relative(rootDirectory, artifact.paths.trace));

  options.runIndex.createRun({
    schemaVersion: 1,
    sessionId,
    configId: config.configId,
    scenarioId: config.scenarioId,
    model: { provider: config.model.provider, name: config.model.name },
    createdAt: createdAt.toISOString(),
    artifacts: {
      manifest: normalizePath(relative(rootDirectory, artifact.paths.manifest)),
      trace: relativeTracePath,
      finalOutput: normalizePath(relative(rootDirectory, artifact.paths.finalOutput)),
    },
  });

  let runtimeResult: RuntimeResult;
  try {
    const registry = options.createTools?.(options.evalCase, config);
    runtimeResult = await runAgent(
      {
        schemaVersion: 1,
        sessionId,
        inputMessage: adaptRepoQaInput(options.evalCase.input),
        config,
      },
      options.createAdapter(options.evalCase, config),
      {
        trace: { recorder: new TraceRecorder({ sessionId, sink: artifact.trace }) },
        ...(registry === undefined ? {} : { tools: { registry } }),
      },
    );
  } catch {
    await artifact.abort('EVAL_RUNNER_EXECUTION_FAILED');
    options.runIndex.finishRun({
      schemaVersion: 1,
      sessionId,
      status: 'failed',
      completedAt: completionTime(createdAt),
    });
    throw new EvalRunnerError('EVAL_RUNNER_EXECUTION_FAILED');
  }

  const finalOutput =
    runtimeResult.status === 'completed'
      ? runtimeResult.finalOutput
      : { error: runtimeResult.error };
  let manifest;
  try {
    manifest = await artifact.finalize({
      status: runtimeResult.status,
      finalOutput,
    });
  } catch {
    options.runIndex.finishRun({
      schemaVersion: 1,
      sessionId,
      status: 'failed',
      completedAt: completionTime(createdAt),
    });
    throw new EvalRunnerError('EVAL_RUNNER_ARTIFACT_FAILED');
  }
  options.runIndex.finishRun({
    schemaVersion: 1,
    sessionId,
    status: runtimeResult.status,
    completedAt: manifest.completedAt,
  });

  try {
    const replay = await replayTraceRun({ sessionDirectory: artifact.paths.sessionDirectory });
    return parseEvalSampleResult(
      scoreEvalCase({
        evalCase: options.evalCase,
        replay,
        tracePath: relativeTracePath,
      }),
    );
  } catch (error) {
    if (error instanceof TraceReplayError) {
      throw new EvalRunnerError('EVAL_RUNNER_ARTIFACT_FAILED');
    }
    throw error;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function completionTime(createdAt: Date): string {
  return new Date(Math.max(Date.now(), createdAt.getTime())).toISOString();
}
