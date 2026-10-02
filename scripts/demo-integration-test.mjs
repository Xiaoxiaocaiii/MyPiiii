import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = resolve('dist/bin.js');
const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-integration-'));
const outputDirectory = join(root, 'demo-output');

function execute(args) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8',
  });
}

try {
  const demo = execute(['demo', '--output', outputDirectory]);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Demo completed\./);
  assert.match(demo.stdout, /Regression samples: repo-qa-01/);

  const baselineReplay = execute([
    'replay',
    '--demo',
    outputDirectory,
    '--variant',
    'baseline',
    '--case',
    'repo-qa-01',
  ]);
  assert.equal(baselineReplay.status, 0, baselineReplay.stderr);
  assert.match(baselineReplay.stdout, /Score passed: true/);
  assert.match(baselineReplay.stdout, /First inconsistency: none/);

  const ablationReplay = execute([
    'replay',
    '--demo',
    outputDirectory,
    '--variant',
    'ablation',
    '--case',
    'repo-qa-01',
  ]);
  assert.equal(ablationReplay.status, 0, ablationReplay.stderr);
  assert.match(ablationReplay.stdout, /Score passed: false/);

  const report = await readFile(join(outputDirectory, 'comparison-report.md'), 'utf8');
  const result = JSON.parse(await readFile(join(outputDirectory, 'demo-result.json'), 'utf8'));
  assert.match(report, /# Eval Comparison Report/);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.report.regressions[0].caseId, 'repo-qa-01');

  process.stdout.write(demo.stdout);
  process.stdout.write(baselineReplay.stdout);
  process.stdout.write(ablationReplay.stdout);
  console.log('Demo integration test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
