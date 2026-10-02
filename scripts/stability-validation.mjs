import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const executable = resolve('dist/bin.js');
const validationRoot = await mkdtemp(join(tmpdir(), 'mypiiii-stability-'));
const summaryPath = resolve('artifacts/stability-summary.json');
const summary = {
  schemaVersion: 1,
  status: 'failed',
  runCount: 5,
  runs: [],
  engineeringFaults: [],
};

function execute(args) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8',
  });
  return {
    result,
    durationMs: Date.now() - startedAt,
  };
}

async function assertFile(path) {
  const details = await stat(path);
  assert.equal(details.isFile(), true);
  assert.ok(details.size > 0);
}

async function validateRun(runNumber) {
  const outputDirectory = join(validationRoot, `run-${String(runNumber).padStart(2, '0')}`);
  const demo = execute(['demo', '--output', outputDirectory]);
  assert.equal(demo.result.status, 0);
  assert.match(demo.result.stdout, /Demo completed\./);

  const result = JSON.parse(await readFile(join(outputDirectory, 'demo-result.json'), 'utf8'));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.baseline.run.samples.length, 20);
  assert.equal(result.ablation.run.samples.length, 20);
  assert.equal(result.baseline.metrics.scorePassRate, 1);
  assert.equal(result.ablation.metrics.scorePassRate, 0.95);
  assert.deepEqual(
    result.report.regressions.map((change) => change.caseId),
    ['repo-qa-01'],
  );
  await assertFile(join(outputDirectory, 'comparison-report.md'));

  const persistedText = [
    await readFile(join(outputDirectory, 'comparison-report.md'), 'utf8'),
    await readFile(join(outputDirectory, 'demo-result.json'), 'utf8'),
  ];
  for (const variant of ['baseline', 'ablation']) {
    await assertFile(join(outputDirectory, variant, 'eval-runs.sqlite'));
    const variantResult = result[variant];
    for (const sample of variantResult.run.samples) {
      const sessionDirectory = join(outputDirectory, variant, dirname(sample.tracePath));
      const files = ['run-manifest.json', 'trace.jsonl', 'final-output.json'];
      for (const file of files) {
        const path = join(sessionDirectory, file);
        await assertFile(path);
        persistedText.push(await readFile(path, 'utf8'));
      }
    }
  }
  for (const contents of persistedText) {
    assert.equal(contents.includes(validationRoot), false);
    assert.equal(contents.includes('pseudo-secret'), false);
  }

  for (const variant of ['baseline', 'ablation']) {
    const replay = execute([
      'replay',
      '--demo',
      outputDirectory,
      '--variant',
      variant,
      '--case',
      'repo-qa-01',
    ]);
    assert.equal(replay.result.status, 0);
    assert.match(replay.result.stdout, /First inconsistency: none/);
  }

  return {
    run: runNumber,
    outputDirectory: `run-${String(runNumber).padStart(2, '0')}`,
    demoDurationMs: demo.durationMs,
    baselineScorePassRate: result.baseline.metrics.scorePassRate,
    ablationScorePassRate: result.ablation.metrics.scorePassRate,
    regressionCount: result.report.regressions.length,
    replayValidated: true,
  };
}

try {
  for (let runNumber = 1; runNumber <= summary.runCount; runNumber += 1) {
    try {
      summary.runs.push(await validateRun(runNumber));
    } catch (error) {
      summary.engineeringFaults.push({
        run: runNumber,
        code: typeof error?.code === 'string' ? error.code : 'STABILITY_RUN_FAILED',
      });
      break;
    }
  }

  summary.status =
    summary.runs.length === summary.runCount && summary.engineeringFaults.length === 0
      ? 'passed'
      : 'failed';
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (summary.status !== 'passed') {
    console.error('Stability validation failed.');
    process.exitCode = 1;
  } else {
    console.log('Five-run stability validation passed.');
    console.log(`Summary: ${summaryPath}`);
    console.log(JSON.stringify(summary));
  }
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}
