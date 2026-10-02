import { z } from 'zod';

import { type EvalExperimentIdentity, type EvalSampleResult } from './eval-contracts.js';
import { evalRunResultSchema, type EvalRunResult } from './eval-runner.js';
import { evalMetricsSchema, type EvalMetrics } from './metrics-aggregator.js';
import { persistedJsonValueSchema } from '../observability/trace-contracts.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const metricDeltaSchema = z.strictObject({
  successRate: z.number().finite(),
  scorePassRate: z.number().finite(),
  meanScore: z.number().finite().nullable(),
});

const variantSchema = z.strictObject({
  configId: identifierSchema,
  configVersion: identifierSchema,
  changes: z
    .array(
      z.strictObject({
        path: identifierSchema,
        value: persistedJsonValueSchema,
      }),
    )
    .min(1),
});

const sampleChangeSchema = z.strictObject({
  caseId: identifierSchema,
  baselinePassed: z.boolean(),
  ablationPassed: z.boolean(),
  tracePath: z.string().min(1),
  failureCategory: identifierSchema.optional(),
});

export const evalComparisonReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  dataset: z.strictObject({
    datasetId: identifierSchema,
    datasetVersion: identifierSchema,
    scenarioId: identifierSchema,
    scenarioVersion: identifierSchema,
    scoringVersion: identifierSchema,
  }),
  baseline: variantSchema,
  ablation: variantSchema,
  primaryVariable: identifierSchema,
  metricDelta: metricDeltaSchema,
  regressions: z.array(sampleChangeSchema),
  improvements: z.array(sampleChangeSchema),
  unchangedCaseCount: z.number().int().nonnegative(),
  unavailableMetrics: z.array(identifierSchema),
  priceSource: z.string().trim().min(1),
  reproductionCommand: z.string().trim().min(1),
  limitations: z.array(z.string().trim().min(1)).min(1),
  markdown: z.string().trim().min(1),
});

export type EvalComparisonReport = z.infer<typeof evalComparisonReportSchema>;

export interface EvalComparisonInput {
  readonly baseline: {
    readonly run: unknown;
    readonly metrics: unknown;
    readonly variant: unknown;
  };
  readonly ablation: {
    readonly run: unknown;
    readonly metrics: unknown;
    readonly variant: unknown;
  };
  readonly primaryVariable: string;
  readonly priceSource: string;
  readonly reproductionCommand: string;
  readonly generatedAt?: Date;
}

export type ComparisonReportErrorCode =
  | 'EVAL_REPORT_INPUT_INVALID'
  | 'EVAL_REPORT_DATASET_MISMATCH'
  | 'EVAL_REPORT_PRIMARY_VARIABLE_INVALID'
  | 'EVAL_REPORT_CASES_MISMATCH';

const errorMessages: Record<ComparisonReportErrorCode, string> = {
  EVAL_REPORT_INPUT_INVALID: 'The comparison report input is invalid',
  EVAL_REPORT_DATASET_MISMATCH: 'The compared runs do not share the same evaluation identity',
  EVAL_REPORT_PRIMARY_VARIABLE_INVALID: 'The comparison must change exactly one primary variable',
  EVAL_REPORT_CASES_MISMATCH: 'The compared runs do not contain the same cases',
};

export class ComparisonReportError extends Error {
  override readonly name = 'ComparisonReportError';
  readonly code: ComparisonReportErrorCode;

  constructor(code: ComparisonReportErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export function createEvalComparisonReport(input: EvalComparisonInput): EvalComparisonReport {
  const baseline = parseRun(input.baseline.run);
  const ablation = parseRun(input.ablation.run);
  const baselineMetrics = parseMetrics(input.baseline.metrics);
  const ablationMetrics = parseMetrics(input.ablation.metrics);
  const baselineVariant = parseVariant(input.baseline.variant);
  const ablationVariant = parseVariant(input.ablation.variant);
  const primaryVariable = parsePrimaryVariable(input.primaryVariable);

  assertIdentityMatches(baseline.experiment, ablation.experiment);
  assertVariantsDifferExactlyOn(baselineVariant, ablationVariant, primaryVariable);
  const baselineCases = indexSamples(baseline.samples);
  const ablationCases = indexSamples(ablation.samples);
  if (
    baselineCases.size !== ablationCases.size ||
    [...baselineCases.keys()].some((caseId) => !ablationCases.has(caseId))
  ) {
    throw new ComparisonReportError('EVAL_REPORT_CASES_MISMATCH');
  }

  const changes = [...baselineCases.keys()].map((caseId) => {
    const baselineSample = baselineCases.get(caseId)!;
    const ablationSample = ablationCases.get(caseId)!;
    const baselinePassed = baselineSample.score?.passed === true;
    const ablationPassed = ablationSample.score?.passed === true;
    return {
      caseId,
      baselinePassed,
      ablationPassed,
      tracePath: ablationSample.tracePath,
      ...(ablationSample.failureCategory === undefined
        ? {}
        : { failureCategory: ablationSample.failureCategory }),
    };
  });
  const regressions = changes.filter((change) => change.baselinePassed && !change.ablationPassed);
  const improvements = changes.filter((change) => !change.baselinePassed && change.ablationPassed);
  const unchangedCaseCount = changes.length - regressions.length - improvements.length;
  const unavailableMetrics = collectUnavailableMetrics(baselineMetrics, ablationMetrics);
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();
  const markdown = renderMarkdown({
    baseline,
    ablation,
    baselineVariant,
    ablationVariant,
    primaryVariable,
    metricDelta: {
      successRate: ablationMetrics.successRate - baselineMetrics.successRate,
      scorePassRate: ablationMetrics.scorePassRate - baselineMetrics.scorePassRate,
      meanScore:
        baselineMetrics.meanScore === null || ablationMetrics.meanScore === null
          ? null
          : ablationMetrics.meanScore - baselineMetrics.meanScore,
    },
    regressions,
    improvements,
    unchangedCaseCount,
    unavailableMetrics,
    priceSource: input.priceSource,
    reproductionCommand: input.reproductionCommand,
  });

  return evalComparisonReportSchema.parse({
    schemaVersion: 1,
    generatedAt,
    dataset: {
      datasetId: baseline.experiment.datasetId,
      datasetVersion: baseline.experiment.datasetVersion,
      scenarioId: baseline.experiment.scenarioId,
      scenarioVersion: baseline.experiment.scenarioVersion,
      scoringVersion: baseline.experiment.scoringVersion,
    },
    baseline: baselineVariant,
    ablation: ablationVariant,
    primaryVariable,
    metricDelta: {
      successRate: ablationMetrics.successRate - baselineMetrics.successRate,
      scorePassRate: ablationMetrics.scorePassRate - baselineMetrics.scorePassRate,
      meanScore:
        baselineMetrics.meanScore === null || ablationMetrics.meanScore === null
          ? null
          : ablationMetrics.meanScore - baselineMetrics.meanScore,
    },
    regressions,
    improvements,
    unchangedCaseCount,
    unavailableMetrics,
    priceSource: input.priceSource,
    reproductionCommand: input.reproductionCommand,
    limitations: [
      'Remote model responses may be non-deterministic; this report does not claim token-level reproduction.',
      'Unavailable token, cost, or timing measurements are excluded from their metric denominators.',
    ],
    markdown,
  });
}

function parseRun(value: unknown): EvalRunResult {
  const result = evalRunResultSchema.safeParse(value);
  if (!result.success) throw new ComparisonReportError('EVAL_REPORT_INPUT_INVALID');
  return result.data;
}

function parseMetrics(value: unknown): EvalMetrics {
  const result = evalMetricsSchema.safeParse(value);
  if (!result.success) throw new ComparisonReportError('EVAL_REPORT_INPUT_INVALID');
  return result.data;
}

function parseVariant(value: unknown): z.infer<typeof variantSchema> {
  const result = variantSchema.safeParse(value);
  if (!result.success) throw new ComparisonReportError('EVAL_REPORT_INPUT_INVALID');
  return result.data;
}

function parsePrimaryVariable(value: string): string {
  if (!identifierSchema.safeParse(value).success) {
    throw new ComparisonReportError('EVAL_REPORT_PRIMARY_VARIABLE_INVALID');
  }
  return value;
}

function assertIdentityMatches(
  baseline: EvalExperimentIdentity,
  ablation: EvalExperimentIdentity,
): void {
  if (
    baseline.datasetId !== ablation.datasetId ||
    baseline.datasetVersion !== ablation.datasetVersion ||
    baseline.scenarioId !== ablation.scenarioId ||
    baseline.scenarioVersion !== ablation.scenarioVersion ||
    baseline.scoringVersion !== ablation.scoringVersion
  ) {
    throw new ComparisonReportError('EVAL_REPORT_DATASET_MISMATCH');
  }
}

function assertVariantsDifferExactlyOn(
  baseline: z.infer<typeof variantSchema>,
  ablation: z.infer<typeof variantSchema>,
  primaryVariable: string,
): void {
  if (baseline.configId === ablation.configId) {
    throw new ComparisonReportError('EVAL_REPORT_PRIMARY_VARIABLE_INVALID');
  }
  const baselinePaths = baseline.changes.map((change) => change.path);
  const ablationPaths = ablation.changes.map((change) => change.path);
  if (
    baselinePaths.length !== 1 ||
    ablationPaths.length !== 1 ||
    baselinePaths[0] !== primaryVariable ||
    ablationPaths[0] !== primaryVariable ||
    JSON.stringify(baseline.changes[0]?.value) === JSON.stringify(ablation.changes[0]?.value)
  ) {
    throw new ComparisonReportError('EVAL_REPORT_PRIMARY_VARIABLE_INVALID');
  }
}

function indexSamples(samples: readonly EvalSampleResult[]): Map<string, EvalSampleResult> {
  return new Map(samples.map((sample) => [sample.caseId, sample]));
}

function collectUnavailableMetrics(baseline: EvalMetrics, ablation: EvalMetrics): string[] {
  const unavailable: string[] = [];
  if (
    baseline.durationMs.status === 'unavailable' ||
    ablation.durationMs.status === 'unavailable'
  ) {
    unavailable.push('durationMs');
  }
  if (
    baseline.tokenUsage.status === 'unavailable' ||
    ablation.tokenUsage.status === 'unavailable'
  ) {
    unavailable.push('tokenUsage');
  }
  if (baseline.cost.status === 'unavailable' || ablation.cost.status === 'unavailable') {
    unavailable.push('cost');
  }
  if (
    baseline.toolErrors.status === 'unavailable' ||
    ablation.toolErrors.status === 'unavailable'
  ) {
    unavailable.push('toolErrors');
  }
  return unavailable;
}

interface MarkdownInput {
  readonly baseline: EvalRunResult;
  readonly ablation: EvalRunResult;
  readonly baselineVariant: z.infer<typeof variantSchema>;
  readonly ablationVariant: z.infer<typeof variantSchema>;
  readonly primaryVariable: string;
  readonly metricDelta: z.infer<typeof metricDeltaSchema>;
  readonly regressions: readonly z.infer<typeof sampleChangeSchema>[];
  readonly improvements: readonly z.infer<typeof sampleChangeSchema>[];
  readonly unchangedCaseCount: number;
  readonly unavailableMetrics: readonly string[];
  readonly priceSource: string;
  readonly reproductionCommand: string;
}

function renderMarkdown(input: MarkdownInput): string {
  const regressionLines =
    input.regressions.length === 0
      ? '- None'
      : input.regressions
          .map(
            (change) =>
              `- \`${change.caseId}\`: Trace \`${change.tracePath}\`${change.failureCategory === undefined ? '' : `, failure category \`${change.failureCategory}\``}`,
          )
          .join('\n');
  const unavailable =
    input.unavailableMetrics.length === 0 ? 'None' : input.unavailableMetrics.join(', ');
  return [
    '# Eval Comparison Report',
    '',
    `- Dataset: \`${input.baseline.experiment.datasetId}@${input.baseline.experiment.datasetVersion}\``,
    `- Scenario: \`${input.baseline.experiment.scenarioId}@${input.baseline.experiment.scenarioVersion}\``,
    `- Baseline: \`${input.baselineVariant.configId}@${input.baselineVariant.configVersion}\``,
    `- Ablation: \`${input.ablationVariant.configId}@${input.ablationVariant.configVersion}\``,
    `- Primary variable: \`${input.primaryVariable}\``,
    '',
    '## Metric Delta (ablation - baseline)',
    '',
    '| Metric | Delta |',
    '| --- | ---: |',
    `| Success rate | ${input.metricDelta.successRate} |`,
    `| Score pass rate | ${input.metricDelta.scorePassRate} |`,
    `| Mean score | ${input.metricDelta.meanScore ?? 'unavailable'} |`,
    '',
    `Unavailable metrics: ${unavailable}.`,
    `Price source: ${input.priceSource}.`,
    '',
    '## Regressions',
    '',
    regressionLines,
    '',
    `Improvements: ${input.improvements.length}; unchanged cases: ${input.unchangedCaseCount}.`,
    '',
    '## Reproduction',
    '',
    `\`${input.reproductionCommand}\``,
    '',
    '## Limitations',
    '',
    '- Remote model responses may be non-deterministic; token-level reproduction is not claimed.',
    '- Missing measurements are excluded from their metric denominators.',
  ].join('\n');
}
