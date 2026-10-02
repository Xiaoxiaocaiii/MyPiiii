import { mkdir, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { FakeModelAdapter } from '../core/fake-model.js';
import type { ExperimentConfig } from '../core/config.js';
import { createSqliteRunIndex } from '../observability/sqlite-run-index.js';
import { aggregateEvalMetrics, evalMetricsSchema, type EvalMetrics } from './metrics-aggregator.js';
import { createEvalComparisonReport, evalComparisonReportSchema } from './comparison-report.js';
import { evalRunResultSchema, runEvaluation, type EvalRunResult } from './eval-runner.js';
import { repoQaDataset } from './repo-qa-dataset.js';
import type { EvalCase } from './eval-contracts.js';

const demoRunSchema = z.strictObject({
  run: evalRunResultSchema,
  metrics: evalMetricsSchema,
});

export const demoResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseline: demoRunSchema,
  ablation: demoRunSchema,
  report: evalComparisonReportSchema,
});

export type DemoResult = z.infer<typeof demoResultSchema>;

export type DemoErrorCode =
  | 'DEMO_ARGUMENTS_INVALID'
  | 'DEMO_OUTPUT_EXISTS'
  | 'DEMO_EXECUTION_FAILED'
  | 'DEMO_ARTIFACT_FAILED';

const errorMessages: Record<DemoErrorCode, string> = {
  DEMO_ARGUMENTS_INVALID: 'The demo arguments are invalid',
  DEMO_OUTPUT_EXISTS: 'The demo output directory already exists',
  DEMO_EXECUTION_FAILED: 'The demo evaluation could not be completed',
  DEMO_ARTIFACT_FAILED: 'The demo artifacts could not be written',
};

export class DemoError extends Error {
  override readonly name = 'DemoError';
  readonly code: DemoErrorCode;

  constructor(code: DemoErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface DemoOptions {
  readonly outputDirectory: string;
  readonly createdAt?: Date;
}

const configTemplate = {
  schemaVersion: 1 as const,
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 128,
  },
  runtime: { maxTurns: 2, timeoutMs: 1_000 },
  tools: { enabled: [] },
};

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  if (options.outputDirectory.trim().length === 0) {
    throw new DemoError('DEMO_ARGUMENTS_INVALID');
  }

  const outputDirectory = resolve(options.outputDirectory);
  await ensureOutputDirectoryAbsent(outputDirectory);

  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch {
    throw new DemoError('DEMO_ARTIFACT_FAILED');
  }

  let result: DemoResult;
  try {
    const createdAt = options.createdAt ?? new Date();
    const baseline = await runVariant(outputDirectory, 'baseline', 0, false, createdAt);
    const ablation = await runVariant(outputDirectory, 'ablation', 0.2, true, createdAt);
    const report = createEvalComparisonReport({
      baseline: {
        run: baseline.run,
        metrics: baseline.metrics,
        variant: {
          configId: 'baseline',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0 }],
        },
      },
      ablation: {
        run: ablation.run,
        metrics: ablation.metrics,
        variant: {
          configId: 'ablation',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0.2 }],
        },
      },
      primaryVariable: 'model.temperature',
      priceSource: 'not configured; token/cost metrics unavailable',
      reproductionCommand: 'npm run dev -- demo --output ./artifacts/demo-01',
      generatedAt: createdAt,
    });
    result = demoResultSchema.parse({
      schemaVersion: 1,
      baseline,
      ablation,
      report,
    });
  } catch (error: unknown) {
    if (error instanceof DemoError) {
      throw error;
    }
    throw new DemoError('DEMO_EXECUTION_FAILED');
  }

  await writeDemoArtifacts(outputDirectory, result);
  return result;
}

export async function runDemoCommand(
  args: readonly string[],
  write: (message: string) => void,
): Promise<void> {
  const outputDirectory = parseOutputArgument(args);
  const result = await runDemo({ outputDirectory });
  const regressions = result.report.regressions.map((change) => change.caseId);
  const unavailableMetrics = result.report.unavailableMetrics;
  const traceRefs = result.report.regressions.map(
    (change) => `${change.caseId}:${change.tracePath}`,
  );

  write('Demo completed.');
  write(`Output directory: ${resolve(outputDirectory)}`);
  write(`Dataset: ${result.report.dataset.datasetId}@${result.report.dataset.datasetVersion}`);
  write(`Baseline score pass rate: ${result.baseline.metrics.scorePassRate}`);
  write(`Ablation score pass rate: ${result.ablation.metrics.scorePassRate}`);
  write(`Regression samples: ${regressions.length === 0 ? 'none' : regressions.join(', ')}`);
  write(
    `Unavailable metrics: ${
      unavailableMetrics.length === 0 ? 'none' : unavailableMetrics.join(', ')
    }`,
  );
  write(`Failure Trace refs: ${traceRefs.length === 0 ? 'none' : traceRefs.join(', ')}`);
  write(`Report: ${join(resolve(outputDirectory), 'comparison-report.md')}`);
  write(`Machine-readable result: ${join(resolve(outputDirectory), 'demo-result.json')}`);
}

function parseOutputArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || args[1]?.trim().length === 0) {
    throw new DemoError('DEMO_ARGUMENTS_INVALID');
  }
  return args[1]!;
}

async function ensureOutputDirectoryAbsent(outputDirectory: string): Promise<void> {
  try {
    await access(outputDirectory);
    throw new DemoError('DEMO_OUTPUT_EXISTS');
  } catch (error: unknown) {
    if (error instanceof DemoError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DemoError('DEMO_ARTIFACT_FAILED');
    }
  }
}

async function runVariant(
  outputDirectory: string,
  configId: 'baseline' | 'ablation',
  temperature: number,
  isAblation: boolean,
  createdAt: Date,
): Promise<{ readonly run: EvalRunResult; readonly metrics: EvalMetrics }> {
  const artifactDirectory = join(outputDirectory, configId);
  await mkdir(artifactDirectory, { recursive: true });
  const runIndex = createSqliteRunIndex({ path: join(artifactDirectory, 'eval-runs.sqlite') });

  try {
    const run = await runEvaluation({
      dataset: repoQaDataset,
      experiment: {
        schemaVersion: 1,
        experimentId: `repo-qa-${configId}`,
        datasetId: repoQaDataset.datasetId,
        datasetVersion: repoQaDataset.version,
        scenarioId: repoQaDataset.scenarioId,
        scenarioVersion: repoQaDataset.scenarioVersion,
        configId,
        configVersion: 'v1',
        scoringVersion: 'v1',
      },
      config: {
        ...configTemplate,
        configId,
        model: { ...configTemplate.model, temperature },
        artifacts: { directory: artifactDirectory },
      } satisfies ExperimentConfig,
      artifactDirectory,
      runIndex,
      createSessionId: (evalCase) => `${configId}-${evalCase.caseId}`,
      createAdapter: (evalCase) => createAdapter(evalCase, isAblation),
      createdAt,
    });
    return {
      run,
      metrics: aggregateEvalMetrics(
        run.samples.map((result) => ({
          result,
          tags: repoQaDataset.cases.find((evalCase) => evalCase.caseId === result.caseId)!.tags,
        })),
      ),
    };
  } finally {
    runIndex.close();
  }
}

function createAdapter(evalCase: EvalCase, isAblation: boolean): FakeModelAdapter {
  const expected = (evalCase.expected as { readonly answer: string }).answer;
  const answer = isAblation && evalCase.caseId === 'repo-qa-01' ? 'src/incorrect.ts' : expected;
  return new FakeModelAdapter([
    {
      type: 'response',
      response: {
        schemaVersion: 1,
        output: {
          schemaVersion: 1,
          type: 'final_answer',
          content: { answer },
        },
      },
    },
  ]);
}

async function writeDemoArtifacts(outputDirectory: string, result: DemoResult): Promise<void> {
  try {
    await writeFile(join(outputDirectory, 'comparison-report.md'), result.report.markdown, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await writeFile(
      join(outputDirectory, 'demo-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
  } catch {
    throw new DemoError('DEMO_ARTIFACT_FAILED');
  }
}
