import { describe, expect, it } from 'vitest';

import { aggregateEvalMetrics, MetricsAggregatorError } from '../../src/eval/metrics-aggregator.js';

const measurement = {
  schemaVersion: 1 as const,
  durationMs: 10,
  tokenUsage: {
    status: 'available' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  },
  cost: {
    status: 'available' as const,
    amount: '0.0001',
    currency: 'USD' as const,
    priceVersion: '2026-01',
  },
};

function result(
  caseId: string,
  status: 'completed' | 'failed',
  score: number,
  failureCategory?: string,
) {
  return {
    schemaVersion: 1 as const,
    caseId,
    sessionId: `session-${caseId}`,
    tracePath: `2026-09-28/${caseId}/trace.jsonl`,
    status,
    score: {
      schemaVersion: 1 as const,
      passed: score === 1,
      score,
      rules: [{ ruleId: 'exact', passed: score === 1, score }],
    },
    ...(failureCategory === undefined ? {} : { failureCode: 'MODEL_CALL_FAILED', failureCategory }),
  };
}

const replayWithTools = {
  schemaVersion: 1 as const,
  sessionId: 'session-case-1',
  status: 'completed' as const,
  createdAt: '2026-09-28T10:00:00.000Z',
  completedAt: '2026-09-28T10:00:01.000Z',
  turns: [
    {
      turnIndex: 0,
      inputMessage: 'question',
      modelOutput: { answer: 'answer' },
      action: {
        schemaVersion: 1 as const,
        type: 'tool_call' as const,
        callId: 'call-1',
        toolName: 'repository.search',
        args: { redacted: true },
      },
      observations: [
        {
          type: 'tool_error' as const,
          schemaVersion: 1 as const,
          callId: 'call-1',
          toolName: 'repository.search',
          code: 'TOOL_FAILED',
          message: 'failed',
          retryable: false,
          durationMs: 1,
        },
        {
          type: 'tool_result' as const,
          schemaVersion: 1 as const,
          callId: 'call-2',
          toolName: 'repository.read',
          data: { ok: true },
          truncated: false,
          durationMs: 2,
        },
      ],
    },
  ],
  finalOutput: { answer: 'answer' },
  eventEvidence: [{ eventId: 'event-1', sequence: 1, timestamp: '2026-09-28T10:00:00.500Z' }],
};

describe('evaluation metrics aggregator', () => {
  it('computes denominators, distributions, tool errors, and exact decimal cost', () => {
    const metrics = aggregateEvalMetrics([
      {
        result: result('case-1', 'completed', 1),
        tags: ['runtime', 'structure'],
        measurement,
        replay: replayWithTools,
      },
      {
        result: result('case-2', 'completed', 0.5),
        tags: ['structure'],
        measurement: {
          schemaVersion: 1,
          durationMs: 20,
          tokenUsage: { status: 'unavailable', reason: 'NOT_REPORTED' },
          cost: { status: 'unavailable', reason: 'NOT_REPORTED' },
        },
      },
      {
        result: result('case-3', 'failed', 0, 'model'),
        tags: ['model'],
        replay: {
          ...replayWithTools,
          sessionId: 'session-case-3',
          status: 'failed',
          finalOutput: undefined,
          failure: { code: 'MODEL_CALL_FAILED', message: 'failed' },
          turns: [],
        },
      },
    ]);

    expect(metrics).toMatchObject({
      sampleCount: 3,
      completedCount: 2,
      failedCount: 1,
      successRate: 2 / 3,
      scorePassRate: 1 / 3,
      meanScore: 0.5,
      durationMs: { status: 'available', sampleCount: 2, totalMs: 30, meanMs: 15 },
      tokenUsage: { status: 'available', sampleCount: 1, totalTokens: 150, unavailableCount: 1 },
      cost: {
        status: 'available',
        sampleCount: 1,
        totalAmount: '0.0001',
        priceVersions: ['2026-01'],
      },
      toolErrors: { status: 'available', errorCount: 1, callCount: 2, errorRate: 0.5 },
      failureDistribution: [{ category: 'model', count: 1 }],
    });
    expect(metrics.tagDistribution).toEqual([
      { tag: 'model', count: 1 },
      { tag: 'runtime', count: 1 },
      { tag: 'structure', count: 2 },
    ]);
    expect(metrics.failureTraceRefs).toEqual([
      { caseId: 'case-3', tracePath: '2026-09-28/case-3/trace.jsonl', category: 'model' },
    ]);
  });

  it('marks metrics unavailable when no measurements or tool calls exist', () => {
    const metrics = aggregateEvalMetrics([
      { result: result('case-1', 'completed', 1), tags: ['runtime'] },
    ]);

    expect(metrics.durationMs).toMatchObject({ status: 'unavailable' });
    expect(metrics.tokenUsage).toMatchObject({ status: 'unavailable', unavailableCount: 0 });
    expect(metrics.cost).toMatchObject({ status: 'unavailable', unavailableCount: 0 });
    expect(metrics.toolErrors).toMatchObject({
      status: 'unavailable',
      callCount: 0,
      errorRate: null,
    });
  });

  it('rejects empty input, duplicate cases, invalid samples, and mismatched Replay', () => {
    expect(() => aggregateEvalMetrics([])).toThrowError(
      new MetricsAggregatorError('EVAL_METRICS_EMPTY'),
    );
    const one = { result: result('case-1', 'completed', 1), tags: ['runtime'] };
    expect(() => aggregateEvalMetrics([one, one])).toThrowError(
      new MetricsAggregatorError('EVAL_METRICS_DUPLICATE_CASE'),
    );
    expect(() => aggregateEvalMetrics([{ result: {}, tags: ['runtime'] }])).toThrowError(
      new MetricsAggregatorError('EVAL_METRICS_SAMPLE_INVALID'),
    );
    expect(() =>
      aggregateEvalMetrics([
        { ...one, replay: { ...replayWithTools, sessionId: 'other-session' } },
      ]),
    ).toThrowError(new MetricsAggregatorError('EVAL_METRICS_REPLAY_MISMATCH'));
  });
});
