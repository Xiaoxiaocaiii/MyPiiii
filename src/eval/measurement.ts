import { z } from 'zod';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const decimalPriceSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);

export const modelUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .superRefine((usage, context) => {
    if (usage.totalTokens < usage.inputTokens + usage.outputTokens) {
      context.addIssue({
        code: 'custom',
        message: 'Total tokens must include input and output tokens',
        path: ['totalTokens'],
      });
    }
  });

export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const modelPriceCardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  priceVersion: identifierSchema,
  provider: identifierSchema,
  model: identifierSchema,
  currency: z.literal('USD'),
  inputPerMillion: decimalPriceSchema,
  outputPerMillion: decimalPriceSchema,
});

export type ModelPriceCard = z.infer<typeof modelPriceCardSchema>;

const unavailableMetricSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: z.enum(['NOT_REPORTED', 'PRICE_NOT_CONFIGURED', 'INVALID_PRICE']),
});

const availableTokenUsageSchema = z.strictObject({
  status: z.literal('available'),
  usage: modelUsageSchema,
});

const availableCostSchema = z.strictObject({
  status: z.literal('available'),
  amount: decimalPriceSchema,
  currency: z.literal('USD'),
  priceVersion: identifierSchema,
});

export const evalMeasurementSchema = z.strictObject({
  schemaVersion: z.literal(1),
  durationMs: z.number().finite().nonnegative(),
  tokenUsage: z.union([availableTokenUsageSchema, unavailableMetricSchema]),
  cost: z.union([availableCostSchema, unavailableMetricSchema]),
});

export type EvalMeasurement = z.infer<typeof evalMeasurementSchema>;
export type MetricUnavailableReason = z.infer<typeof unavailableMetricSchema>['reason'];

export type MeasurementErrorCode =
  | 'EVAL_MEASUREMENT_INPUT_INVALID'
  | 'EVAL_MEASUREMENT_USAGE_INVALID'
  | 'EVAL_MEASUREMENT_PRICE_INVALID';

const errorMessages: Record<MeasurementErrorCode, string> = {
  EVAL_MEASUREMENT_INPUT_INVALID: 'The evaluation measurement input is invalid',
  EVAL_MEASUREMENT_USAGE_INVALID: 'The reported model usage is invalid',
  EVAL_MEASUREMENT_PRICE_INVALID: 'The model price card is invalid',
};

export class MeasurementError extends Error {
  override readonly name = 'MeasurementError';
  readonly code: MeasurementErrorCode;

  constructor(code: MeasurementErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface CreateMeasurementOptions {
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly priceCard?: unknown;
}

export function createEvalMeasurement(options: CreateMeasurementOptions): EvalMeasurement {
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
    throw new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID');
  }

  const usage = parseUsage(options.usage);
  const priceCard = parsePriceCard(options.priceCard);
  const measurement = {
    schemaVersion: 1 as const,
    durationMs: options.durationMs,
    tokenUsage:
      usage === undefined
        ? { status: 'unavailable' as const, reason: 'NOT_REPORTED' as const }
        : { status: 'available' as const, usage },
    cost:
      usage === undefined
        ? { status: 'unavailable' as const, reason: 'NOT_REPORTED' as const }
        : priceCard === undefined
          ? { status: 'unavailable' as const, reason: 'PRICE_NOT_CONFIGURED' as const }
          : {
              status: 'available' as const,
              amount: calculateCost(usage, priceCard),
              currency: 'USD' as const,
              priceVersion: priceCard.priceVersion,
            },
  };
  return evalMeasurementSchema.parse(measurement);
}

export interface MeasureOperationOptions {
  readonly now?: () => number;
  readonly usage?: unknown;
  readonly priceCard?: unknown;
}

export async function measureOperation<T>(
  operation: () => Promise<T>,
  options: MeasureOperationOptions = {},
): Promise<{ value: T; measurement: EvalMeasurement }> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID');
  }

  const value = await operation();
  const completedAt = now();
  if (!Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID');
  }

  return {
    value,
    measurement: createEvalMeasurement({
      durationMs: completedAt - startedAt,
      usage: options.usage,
      priceCard: options.priceCard,
    }),
  };
}

function parseUsage(value: unknown): ModelUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = modelUsageSchema.safeParse(value);
  if (!result.success) {
    throw new MeasurementError('EVAL_MEASUREMENT_USAGE_INVALID');
  }
  return result.data;
}

function parsePriceCard(value: unknown): ModelPriceCard | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = modelPriceCardSchema.safeParse(value);
  if (!result.success) {
    throw new MeasurementError('EVAL_MEASUREMENT_PRICE_INVALID');
  }
  return result.data;
}

function calculateCost(usage: ModelUsage, priceCard: ModelPriceCard): string {
  const inputPrice = parseScaledDecimal(priceCard.inputPerMillion);
  const outputPrice = parseScaledDecimal(priceCard.outputPerMillion);
  const scaledCost =
    roundHalfUp(BigInt(usage.inputTokens) * inputPrice, 1_000_000n) +
    roundHalfUp(BigInt(usage.outputTokens) * outputPrice, 1_000_000n);
  return formatScaledDecimal(scaledCost);
}

function parseScaledDecimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(6, '0')}`);
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

function formatScaledDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}
