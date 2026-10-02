import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeModelAdapter } from '../../src/core/fake-model.js';
import type { ExperimentConfig } from '../../src/core/config.js';
import { createSqliteRunIndex } from '../../src/observability/sqlite-run-index.js';
import { EvalRunnerError, evalRunResultSchema, runEvaluation } from '../../src/eval/eval-runner.js';
import { repoQaDataset } from '../../src/eval/repo-qa-dataset.js';

const config: ExperimentConfig = {
  schemaVersion: 1,
  configId: 'eval-baseline',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic',
    temperature: 0,
    maxOutputTokens: 256,
  },
  runtime: { maxTurns: 2, timeoutMs: 1_000 },
  tools: { enabled: [] },
  artifacts: { directory: './artifacts' },
};

const createdAt = new Date('2026-09-28T10:00:00.000Z');

function experiment() {
  return {
    schemaVersion: 1 as const,
    experimentId: 'repo-qa-baseline',
    datasetId: 'repo-qa-structure',
    datasetVersion: 'v1',
    scenarioId: 'repo-qa',
    scenarioVersion: 'v1',
    configId: 'eval-baseline',
    configVersion: 'v1',
    scoringVersion: 'v1',
  };
}

function adapterFor(caseId: string, fail = false): FakeModelAdapter {
  const evalCase = repoQaDataset.cases.find((candidate) => candidate.caseId === caseId)!;
  const answer = (evalCase.expected as { answer: string }).answer;
  return new FakeModelAdapter([
    fail
      ? { type: 'error', cause: new Error('deterministic test failure') }
      : {
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

describe('evaluation runner', () => {
  it('runs the full dataset sequentially with isolated artifacts and SQLite states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-eval-runner-'));
    const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });
    const order: string[] = [];

    const result = await runEvaluation({
      dataset: repoQaDataset,
      experiment: experiment(),
      config,
      artifactDirectory: root,
      runIndex: index,
      createSessionId: (evalCase) => {
        order.push(evalCase.caseId);
        return `session-${evalCase.caseId}`;
      },
      createTools: () => undefined,
      createAdapter: (evalCase) => adapterFor(evalCase.caseId),
      createdAt,
    });

    expect(evalRunResultSchema.safeParse(result).success).toBe(true);
    expect(result.samples).toHaveLength(20);
    expect(order).toEqual(repoQaDataset.cases.map((evalCase) => evalCase.caseId));
    expect(result.samples.every((sample) => sample.status === 'completed')).toBe(true);
    expect(result.samples.every((sample) => sample.score?.passed === true)).toBe(true);
    expect(index.listRuns('completed')).toHaveLength(20);

    const first = result.samples[0]!;
    expect(first.sessionId).toBe('session-repo-qa-01');
    expect(first.tracePath).toBe('2026-09-28/session-repo-qa-01/trace.jsonl');
    expect(await readFile(join(root, first.tracePath), 'utf8')).toContain('session.started');
    index.close();
  });

  it('keeps a failed sample attributable while continuing the dataset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-eval-runner-failure-'));
    const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });

    const result = await runEvaluation({
      dataset: repoQaDataset,
      experiment: experiment(),
      config,
      artifactDirectory: root,
      runIndex: index,
      createSessionId: (evalCase) => `failure-${evalCase.caseId}`,
      createAdapter: (evalCase) => adapterFor(evalCase.caseId, evalCase.caseId === 'repo-qa-07'),
      createdAt,
    });

    const failed = result.samples.find((sample) => sample.caseId === 'repo-qa-07')!;
    expect(failed).toMatchObject({
      status: 'failed',
      failureCode: 'MODEL_CALL_FAILED',
      failureCategory: 'model',
      score: { passed: false, score: 0 },
    });
    expect(result.samples.filter((sample) => sample.status === 'completed')).toHaveLength(19);
    expect(index.getRun(failed.sessionId)?.status).toBe('failed');
    index.close();
  });

  it('rejects mismatched datasets before creating runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-eval-runner-invalid-'));
    const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });

    await expect(
      runEvaluation({
        dataset: repoQaDataset,
        experiment: { ...experiment(), scenarioId: 'other-scenario' },
        config,
        artifactDirectory: root,
        runIndex: index,
        createAdapter: () => adapterFor('repo-qa-01'),
      }),
    ).rejects.toEqual(new EvalRunnerError('EVAL_RUNNER_SCENARIO_UNSUPPORTED'));
    expect(index.listRuns()).toHaveLength(0);
    index.close();
  });

  it('rejects malformed datasets and normalizes execution failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-eval-runner-errors-'));
    const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });

    await expect(
      runEvaluation({
        dataset: { schemaVersion: 1 },
        experiment: experiment(),
        config,
        artifactDirectory: root,
        runIndex: index,
        createAdapter: () => adapterFor('repo-qa-01'),
      }),
    ).rejects.toEqual(new EvalRunnerError('EVAL_RUNNER_DATASET_INVALID'));

    await expect(
      runEvaluation({
        dataset: { ...repoQaDataset, cases: repoQaDataset.cases.slice(0, 20) },
        experiment: experiment(),
        config,
        artifactDirectory: root,
        runIndex: index,
        createSessionId: () => 'execution-failure',
        createAdapter: () => {
          throw new Error('private adapter failure');
        },
      }),
    ).rejects.toEqual(new EvalRunnerError('EVAL_RUNNER_EXECUTION_FAILED'));
    expect(index.getRun('execution-failure')?.status).toBe('failed');

    await expect(
      runEvaluation({
        dataset: repoQaDataset,
        experiment: experiment(),
        config,
        artifactDirectory: root,
        runIndex: index,
        createSessionId: () => 'artifact-failure',
        createAdapter: (evalCase) => adapterFor(evalCase.caseId),
        createdAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toEqual(new EvalRunnerError('EVAL_RUNNER_ARTIFACT_FAILED'));
    expect(index.getRun('artifact-failure')?.status).toBe('failed');
    index.close();
  });
});
