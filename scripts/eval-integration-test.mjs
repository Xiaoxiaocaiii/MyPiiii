import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  FakeModelAdapter,
  aggregateEvalMetrics,
  createEvalComparisonReport,
  createSqliteRunIndex,
  evalComparisonReportSchema,
  evalRunResultSchema,
  loadTraceRun,
  replayTraceRun,
  repoQaDataset,
  runEvaluation,
} from '../dist/index.js';

const createdAt = new Date('2026-09-28T10:00:00.000Z');
const configTemplate = {
  schemaVersion: 1,
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

function createConfig(configId, temperature, directory) {
  return {
    ...configTemplate,
    configId,
    model: { ...configTemplate.model, temperature },
    artifacts: { directory },
  };
}

function createExperiment(configId) {
  return {
    schemaVersion: 1,
    experimentId: `repo-qa-${configId}`,
    datasetId: repoQaDataset.datasetId,
    datasetVersion: repoQaDataset.version,
    scenarioId: repoQaDataset.scenarioId,
    scenarioVersion: repoQaDataset.scenarioVersion,
    configId,
    configVersion: 'v1',
    scoringVersion: 'v1',
  };
}

function createAdapter(evalCase, isAblation) {
  const expected = evalCase.expected.answer;
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

async function runVariant(root, configId, temperature, isAblation) {
  await mkdir(root, { recursive: true });
  const index = createSqliteRunIndex({ path: join(root, 'runs.sqlite') });
  try {
    return await runEvaluation({
      dataset: repoQaDataset,
      experiment: createExperiment(configId),
      config: createConfig(configId, temperature, root),
      artifactDirectory: root,
      runIndex: index,
      createSessionId: (evalCase) => `${configId}-${evalCase.caseId}`,
      createAdapter: (evalCase) => createAdapter(evalCase, isAblation),
      createdAt,
    });
  } finally {
    index.close();
  }
}

function createMetrics(run) {
  return aggregateEvalMetrics(
    run.samples.map((result) => ({
      result,
      tags: repoQaDataset.cases.find((evalCase) => evalCase.caseId === result.caseId).tags,
    })),
  );
}

async function assertReplayEvidence(root, run) {
  for (const sample of run.samples) {
    const sessionDirectory = join(root, dirname(sample.tracePath));
    const loaded = await loadTraceRun({ sessionDirectory });
    const replay = await replayTraceRun({ sessionDirectory });
    assert.equal(replay.sessionId, sample.sessionId);
    assert.equal(replay.status, sample.status);
    assert.ok(loaded.events.length >= 4);
    const traceText = await readFile(join(root, sample.tracePath), 'utf8');
    assert.equal(traceText.includes('pseudo-secret'), false);
  }
}

const root = await mkdtemp(join(tmpdir(), 'mypiiii-eval-integration-'));
const baselineRoot = join(root, 'baseline');
const ablationRoot = join(root, 'ablation');

try {
  const baseline = await runVariant(baselineRoot, 'baseline', 0, false);
  const ablation = await runVariant(ablationRoot, 'ablation', 0.2, true);
  assert.equal(evalRunResultSchema.safeParse(baseline).success, true);
  assert.equal(evalRunResultSchema.safeParse(ablation).success, true);
  assert.equal(baseline.samples.length, 20);
  assert.equal(ablation.samples.length, 20);
  assert.equal(
    baseline.samples.every((sample) => sample.score?.passed === true),
    true,
  );
  assert.equal(ablation.samples.filter((sample) => sample.score?.passed === false).length, 1);

  await assertReplayEvidence(baselineRoot, baseline);
  await assertReplayEvidence(ablationRoot, ablation);

  const report = createEvalComparisonReport({
    baseline: {
      run: baseline,
      metrics: createMetrics(baseline),
      variant: {
        configId: 'baseline',
        configVersion: 'v1',
        changes: [{ path: 'model.temperature', value: 0 }],
      },
    },
    ablation: {
      run: ablation,
      metrics: createMetrics(ablation),
      variant: {
        configId: 'ablation',
        configVersion: 'v1',
        changes: [{ path: 'model.temperature', value: 0.2 }],
      },
    },
    primaryVariable: 'model.temperature',
    priceSource: 'not configured; token/cost metrics unavailable',
    reproductionCommand: 'npm run test:integration',
  });

  assert.equal(evalComparisonReportSchema.safeParse(report).success, true);
  assert.deepEqual(
    report.regressions.map((change) => change.caseId),
    ['repo-qa-01'],
  );
  assert.equal(report.unavailableMetrics.includes('tokenUsage'), true);
  assert.equal(report.markdown.includes('npm run test:integration'), true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Evaluation integration test passed.');
