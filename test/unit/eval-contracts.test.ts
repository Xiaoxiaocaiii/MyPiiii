import { describe, expect, it } from 'vitest';

import {
  EvalContractError,
  evalDatasetSchema,
  parseEvalCase,
  parseEvalDataset,
  parseEvalExperimentIdentity,
  parseEvalSampleResult,
  parseEvalScoreResult,
  type EvalCase,
  type EvalDataset,
} from '../../src/eval/eval-contracts.js';

function createCase(caseId: string): EvalCase {
  return {
    schemaVersion: 1,
    caseId,
    input: { question: `Question ${caseId}` },
    expected: { answer: caseId },
    tags: ['basic'],
    scoringRules: [{ ruleId: 'exact', type: 'exact_match' }],
  };
}

function createDataset(count = 20): EvalDataset {
  return {
    schemaVersion: 1,
    datasetId: 'repo-qa-small',
    version: 'v1',
    scenarioId: 'repo-qa',
    scenarioVersion: 'v1',
    cases: Array.from({ length: count }, (_, index) => createCase(`case-${index + 1}`)),
  };
}

describe('eval contracts', () => {
  it('parses a versioned case and preserves JSON-safe values', () => {
    const value = createCase('case-1');

    expect(parseEvalCase(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('rejects duplicate scoring rule IDs and sensitive case values', () => {
    expect(() =>
      parseEvalCase({
        ...createCase('case-1'),
        scoringRules: [
          { ruleId: 'same', type: 'exact_match' },
          { ruleId: 'same', type: 'schema_valid' },
        ],
      }),
    ).toThrowError(new EvalContractError('EVAL_CASE_INVALID'));

    const secret = 'do-not-persist';
    let thrown: unknown;
    try {
      parseEvalCase({
        ...createCase('case-1'),
        input: { nested: { password: secret } },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EvalContractError);
    expect(String(thrown)).not.toContain(secret);
  });

  it('requires between 20 and 50 unique cases in a dataset', () => {
    expect(parseEvalDataset(createDataset())).toEqual(createDataset());
    expect(() => parseEvalDataset(createDataset(19))).toThrowError(
      new EvalContractError('EVAL_DATASET_INVALID'),
    );
    expect(() => parseEvalDataset(createDataset(51))).toThrowError(
      new EvalContractError('EVAL_DATASET_INVALID'),
    );

    const duplicate = createDataset();
    duplicate.cases[1] = duplicate.cases[0]!;
    expect(() => parseEvalDataset(duplicate)).toThrowError(
      new EvalContractError('EVAL_DATASET_INVALID'),
    );
  });

  it('rejects unsupported versions, extra fields, and unsafe values', () => {
    expect(evalDatasetSchema.safeParse({ ...createDataset(), schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(evalDatasetSchema.safeParse({ ...createDataset(), unexpected: true }).success).toBe(
      false,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      parseEvalCase({
        ...createCase('case-1'),
        input: cyclic,
      }),
    ).toThrowError(new EvalContractError('EVAL_CASE_INVALID'));
  });

  it('parses experiment identity, score, and sample result contracts', () => {
    expect(
      parseEvalExperimentIdentity({
        schemaVersion: 1,
        experimentId: 'baseline-v1',
        datasetId: 'repo-qa-small',
        datasetVersion: 'v1',
        scenarioId: 'repo-qa',
        scenarioVersion: 'v1',
        configId: 'baseline',
        configVersion: 'v1',
        scoringVersion: 'v1',
      }),
    ).toMatchObject({ experimentId: 'baseline-v1' });

    const score = parseEvalScoreResult({
      schemaVersion: 1,
      passed: true,
      score: 1,
      rules: [{ ruleId: 'exact', passed: true, score: 1 }],
    });
    expect(score.passed).toBe(true);

    const sample = parseEvalSampleResult({
      schemaVersion: 1,
      caseId: 'case-1',
      sessionId: 'session-1',
      tracePath: 'trace.jsonl',
      status: 'completed',
      score,
    });
    expect(sample.tracePath).toBe('trace.jsonl');
  });

  it('rejects invalid result contracts without exposing input values', () => {
    const secret = 'private-value';
    let thrown: unknown;
    try {
      parseEvalSampleResult({
        schemaVersion: 1,
        caseId: 'case-1',
        sessionId: 'session-1',
        tracePath: '../trace.jsonl',
        status: 'failed',
        failureCode: secret,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new EvalContractError('EVAL_SAMPLE_INVALID'));
    expect(String(thrown)).not.toContain(secret);

    expect(() =>
      parseEvalScoreResult({
        schemaVersion: 1,
        passed: true,
        score: 2,
        rules: [],
      }),
    ).toThrowError(new EvalContractError('EVAL_SCORE_INVALID'));
    expect(() =>
      parseEvalExperimentIdentity({
        schemaVersion: 2,
        experimentId: 'baseline-v1',
      }),
    ).toThrowError(new EvalContractError('EVAL_EXPERIMENT_INVALID'));
  });
});
