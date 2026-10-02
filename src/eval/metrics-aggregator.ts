import { z } from 'zod';

import { evalSampleResultSchema, type EvalSampleResult } from './eval-contracts.js';
import { evalMeasurementSchema, type EvalMeasurement } from './measurement.js';
import { replayResultSchema, type ReplayResult } from '../observability/trace-replay.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const rateSchema = z.number().finite().min(0).max(1);

const availableDurationSchema = z.strictObject({
  status: z.literal('available'),
  sampleCount: z.number().int().positive(),
  totalMs: z.number().finite().nonnegative(),
  meanMs: z.number().finite().nonnegative(),
});

const unavailableDurationSchema = z.strictObject({
  status: z.literal('unavailable'),
  sampleCount: z.literal(0),
  reason: z.literal('NO_VALID_MEASUREMENTS'),
});

const availableTokensSchema = z.strictObject({
  status: z.literal('available'),
  sampleCount: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
});

const unavailableTokensSchema = z.strictObject({
  status: z.literal('unavailable'),
  sampleCount: z.literal(0),
  unavailableCount: z.number().int().nonnegative(),
  reason: z.literal('NO_REPORTED_USAGE'),
});

const availableCostSchema = z.strictObject({
  status: z.literal('available'),
  sampleCount: z.number().int().positive(),
  totalAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/),
  currency: z.literal('USD'),
  priceVersions: z.array(identifierSchema).min(1),
  unavailableCount: z.number().int().nonnegative(),
});

const unavailableCostSchema = z.strictObject({
  status: z.literal('unavailable'),
  sampleCount: z.literal(0),
  unavailableCount: z.number().int().nonnegative(),
  reason: z.literal('NO_PRICED_MEASUREMENTS'),
});

const toolMetricSchema = z.union([
  z.strictObject({
    status: z.literal('available'),
    errorCount: z.number().int().nonnegative(),
    callCount: z.number().int().positive(),
    errorRate: rateSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    errorCount: z.literal(0),
    callCount: z.literal(0),
    errorRate: z.literal(null),
    reason: z.literal('NO_TOOL_CALLS'),
  }),
]);

export const evalMetricsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sampleCount: z.number().int().positive(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  successRate: rateSchema,
  scorePassRate: rateSchema,
  meanScore: rateSchema.nullable(),
  durationMs: z.union([availableDurationSchema, unavailableDurationSchema]),
  tokenUsage: z.union([availableTokensSchema, unavailableTokensSchema]),
  cost: z.union([availableCostSchema, unavailableCostSchema]),
  toolErrors: toolMetricSchema,
  tagDistribution: z.array(
    z.strictObject({ tag: identifierSchema, count: z.number().int().positive() }),
  ),
  failureDistribution: z.array(
    z.strictObject({
      category: identifierSchema,
      count: z.number().int().positive(),
    }),
  ),
  failureTraceRefs: z.array(
    z.strictObject({
      caseId: identifierSchema,
      tracePath: z.string().min(1),
      category: identifierSchema,
    }),
  ),
});

export type EvalMetrics = z.infer<typeof evalMetricsSchema>;

export interface EvalMetricSample {
  readonly result: unknown;
  readonly tags: readonly string[];
  readonly measurement?: unknown;
  readonly replay?: unknown;
}

export type MetricsAggregatorErrorCode =
  | 'EVAL_METRICS_EMPTY'
  | 'EVAL_METRICS_SAMPLE_INVALID'
  | 'EVAL_METRICS_DUPLICATE_CASE'
  | 'EVAL_METRICS_REPLAY_MISMATCH';

const errorMessages: Record<MetricsAggregatorErrorCode, string> = {
  EVAL_METRICS_EMPTY: 'At least one evaluation sample is required',
  EVAL_METRICS_SAMPLE_INVALID: 'The evaluation metric sample is invalid',
  EVAL_METRICS_DUPLICATE_CASE: 'Evaluation case IDs must be unique',
  EVAL_METRICS_REPLAY_MISMATCH: 'Replay evidence does not match the sample result',
};

export class MetricsAggregatorError extends Error {
  override readonly name = 'MetricsAggregatorError';
  readonly code: MetricsAggregatorErrorCode;

  constructor(code: MetricsAggregatorErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

interface ParsedMetricSample {
  readonly result: EvalSampleResult;
  readonly tags: readonly string[];
  readonly measurement?: EvalMeasurement;
  readonly replay?: ReplayResult;
}

export function aggregateEvalMetrics(samples: readonly EvalMetricSample[]): EvalMetrics {
  if (samples.length === 0) {
    throw new MetricsAggregatorError('EVAL_METRICS_EMPTY');
  }

  const seenCases = new Set<string>();
  const parsed = samples.map((sample) => parseSample(sample, seenCases));
  const completedCount = parsed.filter((sample) => sample.result.status === 'completed').length;
  const scored = parsed.filter((sample) => sample.result.score !== undefined);
  const passed = scored.filter((sample) => sample.result.score?.passed === true).length;
  const scores = scored.map((sample) => sample.result.score!.score);
  const measurements = parsed
    .map((sample) => sample.measurement)
    .filter((measurement): measurement is EvalMeasurement => measurement !== undefined);
  const usage = measurements.filter((measurement) => measurement.tokenUsage.status === 'available');
  const priced = measurements.filter((measurement) => measurement.cost.status === 'available');
  const toolCalls = parsed.flatMap(
    (sample) => sample.replay?.turns.flatMap((turn) => turn.observations) ?? [],
  );
  const toolErrors = toolCalls.filter((observation) => observation.type === 'tool_error').length;
  const tags = countValues(parsed.flatMap((sample) => sample.tags));
  const failures = countValues(
    parsed.flatMap((sample) =>
      sample.result.failureCategory === undefined ? [] : [sample.result.failureCategory],
    ),
  );

  return evalMetricsSchema.parse({
    schemaVersion: 1,
    sampleCount: parsed.length,
    completedCount,
    failedCount: parsed.length - completedCount,
    successRate: completedCount / parsed.length,
    scorePassRate: scored.length === 0 ? 0 : passed / scored.length,
    meanScore:
      scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    durationMs:
      measurements.length === 0
        ? { status: 'unavailable', sampleCount: 0, reason: 'NO_VALID_MEASUREMENTS' }
        : {
            status: 'available',
            sampleCount: measurements.length,
            totalMs: measurements.reduce((sum, measurement) => sum + measurement.durationMs, 0),
            meanMs:
              measurements.reduce((sum, measurement) => sum + measurement.durationMs, 0) /
              measurements.length,
          },
    tokenUsage:
      usage.length === 0
        ? {
            status: 'unavailable',
            sampleCount: 0,
            unavailableCount: measurements.length,
            reason: 'NO_REPORTED_USAGE',
          }
        : {
            status: 'available',
            sampleCount: usage.length,
            inputTokens: usage.reduce(
              (sum, measurement) =>
                sum +
                (measurement.tokenUsage.status === 'available'
                  ? measurement.tokenUsage.usage.inputTokens
                  : 0),
              0,
            ),
            outputTokens: usage.reduce(
              (sum, measurement) =>
                sum +
                (measurement.tokenUsage.status === 'available'
                  ? measurement.tokenUsage.usage.outputTokens
                  : 0),
              0,
            ),
            totalTokens: usage.reduce(
              (sum, measurement) =>
                sum +
                (measurement.tokenUsage.status === 'available'
                  ? measurement.tokenUsage.usage.totalTokens
                  : 0),
              0,
            ),
            unavailableCount: measurements.length - usage.length,
          },
    cost:
      priced.length === 0
        ? {
            status: 'unavailable',
            sampleCount: 0,
            unavailableCount: measurements.length,
            reason: 'NO_PRICED_MEASUREMENTS',
          }
        : {
            status: 'available',
            sampleCount: priced.length,
            totalAmount: sumAmounts(
              priced.map((measurement) =>
                measurement.cost.status === 'available' ? measurement.cost.amount : '0',
              ),
            ),
            currency: 'USD',
            priceVersions: [
              ...new Set(
                priced
                  .map((measurement) =>
                    measurement.cost.status === 'available' ? measurement.cost.priceVersion : '',
                  )
                  .filter(Boolean),
              ),
            ],
            unavailableCount: measurements.length - priced.length,
          },
    toolErrors:
      toolCalls.length === 0
        ? {
            status: 'unavailable',
            errorCount: 0,
            callCount: 0,
            errorRate: null,
            reason: 'NO_TOOL_CALLS',
          }
        : {
            status: 'available',
            errorCount: toolErrors,
            callCount: toolCalls.length,
            errorRate: toolErrors / toolCalls.length,
          },
    tagDistribution: tags.map(([tag, count]) => ({ tag, count })),
    failureDistribution: failures.map(([category, count]) => ({ category, count })),
    failureTraceRefs: parsed
      .filter((sample) => sample.result.failureCategory !== undefined)
      .map((sample) => ({
        caseId: sample.result.caseId,
        tracePath: sample.result.tracePath,
        category: sample.result.failureCategory!,
      })),
  });
}

function parseSample(sample: EvalMetricSample, seenCases: Set<string>): ParsedMetricSample {
  const result = evalSampleResultSchema.safeParse(sample.result);
  const tags = sample.tags.every((tag) => identifierSchema.safeParse(tag).success);
  const measurement =
    sample.measurement === undefined
      ? undefined
      : evalMeasurementSchema.safeParse(sample.measurement);
  const replay =
    sample.replay === undefined ? undefined : replayResultSchema.safeParse(sample.replay);
  if (!result.success || !tags || (sample.measurement !== undefined && !measurement?.success)) {
    throw new MetricsAggregatorError('EVAL_METRICS_SAMPLE_INVALID');
  }
  if (seenCases.has(result.data.caseId)) {
    throw new MetricsAggregatorError('EVAL_METRICS_DUPLICATE_CASE');
  }
  if (
    sample.replay !== undefined &&
    (!replay?.success ||
      replay.data.sessionId !== result.data.sessionId ||
      replay.data.status !== result.data.status)
  ) {
    throw new MetricsAggregatorError('EVAL_METRICS_REPLAY_MISMATCH');
  }
  seenCases.add(result.data.caseId);
  return {
    result: result.data,
    tags: [...sample.tags],
    ...(measurement?.success ? { measurement: measurement.data } : {}),
    ...(replay?.success ? { replay: replay.data } : {}),
  };
}

function countValues(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function sumAmounts(amounts: readonly string[]): string {
  const total = amounts.reduce((sum, amount) => sum + parseAmount(amount), 0n);
  const whole = total / 1_000_000n;
  const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function parseAmount(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(6, '0')}`);
}
