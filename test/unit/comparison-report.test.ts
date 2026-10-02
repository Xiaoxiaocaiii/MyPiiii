import { describe, expect, it } from 'vitest';

import {
  ComparisonReportError,
  createEvalComparisonReport,
} from '../../src/eval/comparison-report.js';
import { aggregateEvalMetrics } from '../../src/eval/metrics-aggregator.js';

const experiment = (configId: string) => ({
  schemaVersion: 1 as const,
  experimentId: `exp-${configId}`,
  datasetId: 'repo-qa-structure',
  datasetVersion: 'v1',
  scenarioId: 'repo-qa',
  scenarioVersion: 'v1',
  configId,
  configVersion: 'v1',
  scoringVersion: 'v1',
});

function sample(caseId: string, passed: boolean, failureCategory?: 'model' | 'tool') {
  return {
    schemaVersion: 1 as const,
    caseId,
    sessionId: `${caseId}-session`,
    tracePath: `2026-09-28/${caseId}/trace.jsonl`,
    status: passed ? ('completed' as const) : ('failed' as const),
    score: {
      schemaVersion: 1 as const,
      passed,
      score: passed ? 1 : 0,
      rules: [{ ruleId: 'exact', passed, score: passed ? 1 : 0 }],
    },
    ...(failureCategory === undefined ? {} : { failureCode: 'MODEL_CALL_FAILED', failureCategory }),
  };
}

function run(configId: string, samples: readonly ReturnType<typeof sample>[]) {
  return {
    schemaVersion: 1 as const,
    experiment: experiment(configId),
    samples,
  };
}

function metrics(samples: readonly ReturnType<typeof sample>[]) {
  return aggregateEvalMetrics(samples.map((result) => ({ result, tags: ['repo-qa'] })));
}

const baselineSamples = [sample('case-1', true), sample('case-2', false, 'model')];
const ablationSamples = [sample('case-1', false, 'tool'), sample('case-2', true)];

describe('comparison report', () => {
  it('compares two variants and renders regression Trace references', () => {
    const report = createEvalComparisonReport({
      baseline: {
        run: run('baseline', baselineSamples),
        metrics: metrics(baselineSamples),
        variant: {
          configId: 'baseline',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0 }],
        },
      },
      ablation: {
        run: run('ablation', ablationSamples),
        metrics: metrics(ablationSamples),
        variant: {
          configId: 'ablation',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0.2 }],
        },
      },
      primaryVariable: 'model.temperature',
      priceSource: 'not configured',
      reproductionCommand: 'npm run eval -- --dataset repo-qa-structure@v1',
      generatedAt: new Date('2026-09-28T12:00:00.000Z'),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      primaryVariable: 'model.temperature',
      regressions: [
        {
          caseId: 'case-1',
          tracePath: '2026-09-28/case-1/trace.jsonl',
          failureCategory: 'tool',
        },
      ],
      improvements: [{ caseId: 'case-2' }],
      unchangedCaseCount: 0,
      unavailableMetrics: ['durationMs', 'tokenUsage', 'cost', 'toolErrors'],
    });
    expect(report.markdown).toContain('# Eval Comparison Report');
    expect(report.markdown).toContain('case-1');
    expect(report.markdown).toContain('npm run eval');
  });

  it('rejects identity, variable, and case mismatches', () => {
    const base = {
      baseline: {
        run: run('baseline', baselineSamples),
        metrics: metrics(baselineSamples),
        variant: {
          configId: 'baseline',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0 }],
        },
      },
      ablation: {
        run: run('ablation', ablationSamples),
        metrics: metrics(ablationSamples),
        variant: {
          configId: 'ablation',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0.2 }],
        },
      },
      primaryVariable: 'model.temperature',
      priceSource: 'not configured',
      reproductionCommand: 'npm run eval',
    };

    expect(() =>
      createEvalComparisonReport({
        ...base,
        ablation: {
          ...base.ablation,
          run: {
            ...base.ablation.run,
            experiment: { ...experiment('ablation'), datasetVersion: 'v2' },
          },
        },
      }),
    ).toThrowError(new ComparisonReportError('EVAL_REPORT_DATASET_MISMATCH'));
    expect(() =>
      createEvalComparisonReport({
        ...base,
        primaryVariable: 'model.temperature',
        ablation: {
          ...base.ablation,
          variant: {
            configId: 'ablation',
            configVersion: 'v1',
            changes: [{ path: 'model.temperature', value: 0 }],
          },
        },
      }),
    ).toThrowError(new ComparisonReportError('EVAL_REPORT_PRIMARY_VARIABLE_INVALID'));
    expect(() =>
      createEvalComparisonReport({
        ...base,
        ablation: {
          ...base.ablation,
          run: run('ablation', [sample('case-other', true), sample('case-2', true)]),
        },
      }),
    ).toThrowError(new ComparisonReportError('EVAL_REPORT_CASES_MISMATCH'));
  });

  it('renders a no-regression report with available measurement deltas', () => {
    const stableSamples = [sample('case-1', true)];
    const measured = {
      schemaVersion: 1 as const,
      durationMs: 8,
      tokenUsage: {
        status: 'available' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      cost: {
        status: 'available' as const,
        amount: '0.00001',
        currency: 'USD' as const,
        priceVersion: '2026-01',
      },
    };
    const measuredMetrics = aggregateEvalMetrics([
      { result: stableSamples[0], tags: ['stable'], measurement: measured },
    ]);
    const report = createEvalComparisonReport({
      baseline: {
        run: run('baseline', stableSamples),
        metrics: measuredMetrics,
        variant: {
          configId: 'baseline',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0 }],
        },
      },
      ablation: {
        run: run('ablation', stableSamples),
        metrics: measuredMetrics,
        variant: {
          configId: 'ablation',
          configVersion: 'v1',
          changes: [{ path: 'model.temperature', value: 0.2 }],
        },
      },
      primaryVariable: 'model.temperature',
      priceSource: 'price-card@2026-01',
      reproductionCommand: 'npm run eval',
    });

    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
    expect(report.unavailableMetrics).toEqual(['toolErrors']);
    expect(report.markdown).toContain('- None');
  });
});
