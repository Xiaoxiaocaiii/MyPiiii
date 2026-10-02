import { describe, expect, it } from 'vitest';

import {
  createEvalMeasurement,
  MeasurementError,
  measureOperation,
  type ModelPriceCard,
  type ModelUsage,
} from '../../src/eval/measurement.js';

const usage: ModelUsage = {
  inputTokens: 1_000,
  outputTokens: 500,
  totalTokens: 1_500,
};

const priceCard: ModelPriceCard = {
  schemaVersion: 1,
  priceVersion: '2026-01',
  provider: 'fake',
  model: 'deterministic-model',
  currency: 'USD',
  inputPerMillion: '0.15',
  outputPerMillion: '0.60',
};

describe('evaluation measurement', () => {
  it('records explicit usage, duration, and deterministic decimal cost', () => {
    expect(
      createEvalMeasurement({
        durationMs: 12.5,
        usage,
        priceCard,
      }),
    ).toEqual({
      schemaVersion: 1,
      durationMs: 12.5,
      tokenUsage: { status: 'available', usage },
      cost: {
        status: 'available',
        amount: '0.00045',
        currency: 'USD',
        priceVersion: '2026-01',
      },
    });
  });

  it('marks missing usage and price as unavailable instead of zero', () => {
    expect(createEvalMeasurement({ durationMs: 3 })).toEqual({
      schemaVersion: 1,
      durationMs: 3,
      tokenUsage: { status: 'unavailable', reason: 'NOT_REPORTED' },
      cost: { status: 'unavailable', reason: 'NOT_REPORTED' },
    });
    expect(createEvalMeasurement({ durationMs: 3, usage })).toMatchObject({
      tokenUsage: { status: 'available', usage },
      cost: { status: 'unavailable', reason: 'PRICE_NOT_CONFIGURED' },
    });
  });

  it('measures asynchronous duration with an injected clock', async () => {
    const times = [100, 137];
    const measured = await measureOperation(() => Promise.resolve('done'), {
      now: () => times.shift()!,
      usage,
      priceCard,
    });

    expect(measured).toMatchObject({
      value: 'done',
      measurement: { durationMs: 37, tokenUsage: { status: 'available' } },
    });
  });

  it('rejects invalid usage, prices, and clock/duration values', async () => {
    expect(() =>
      createEvalMeasurement({
        durationMs: 1,
        usage: { ...usage, totalTokens: 1 },
      }),
    ).toThrowError(new MeasurementError('EVAL_MEASUREMENT_USAGE_INVALID'));
    expect(() =>
      createEvalMeasurement({
        durationMs: 1,
        usage,
        priceCard: { ...priceCard, inputPerMillion: '0.1234567' },
      }),
    ).toThrowError(new MeasurementError('EVAL_MEASUREMENT_PRICE_INVALID'));
    expect(() => createEvalMeasurement({ durationMs: -1 })).toThrowError(
      new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID'),
    );
    await expect(
      measureOperation(() => Promise.resolve('done'), {
        now: () => Number.NaN,
      }),
    ).rejects.toEqual(new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID'));
  });

  it('rejects a clock that moves backwards', async () => {
    const times = [100, 99];
    await expect(
      measureOperation(() => Promise.resolve('done'), {
        now: () => times.shift()!,
      }),
    ).rejects.toEqual(new MeasurementError('EVAL_MEASUREMENT_INPUT_INVALID'));
  });
});
