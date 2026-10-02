import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = resolve('.');
const npmCliPath =
  process.env.npm_execpath ??
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const validationRoot = await mkdtemp(join(tmpdir(), 'mypiiii-fresh-environment-'));
const cleanRoot = join(validationRoot, 'checkout');
const outputDirectory = join(cleanRoot, 'artifacts', 'fresh-demo');
const timings = [];

function run(command, args, cwd) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  timings.push({
    command: `${command} ${args.join(' ')}`,
    durationMs: Date.now() - startedAt,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
  );
  return result;
}

function runNpm(args) {
  return run(process.execPath, [npmCliPath, ...args], cleanRoot);
}

async function assertFile(path) {
  const details = await stat(path);
  assert.equal(details.isFile(), true, `Expected file: ${path}`);
  assert.ok(details.size > 0, `Expected non-empty file: ${path}`);
}

async function assertDemoArtifacts(result) {
  await assertFile(join(outputDirectory, 'comparison-report.md'));
  await assertFile(join(outputDirectory, 'demo-result.json'));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.baseline.run.samples.length, 20);
  assert.equal(result.ablation.run.samples.length, 20);
  assert.equal(result.report.regressions[0].caseId, 'repo-qa-01');

  const persistedFiles = [];
  for (const variant of ['baseline', 'ablation']) {
    const variantResult = result[variant];
    await assertFile(join(outputDirectory, variant, 'eval-runs.sqlite'));
    for (const sample of variantResult.run.samples) {
      const sessionDirectory = join(outputDirectory, variant, dirname(sample.tracePath));
      const manifestPath = join(sessionDirectory, 'run-manifest.json');
      const tracePath = join(sessionDirectory, 'trace.jsonl');
      const finalOutputPath = join(sessionDirectory, 'final-output.json');
      await assertFile(manifestPath);
      await assertFile(tracePath);
      await assertFile(finalOutputPath);
      persistedFiles.push(manifestPath, tracePath, finalOutputPath);
    }
  }

  const text = await Promise.all(
    [
      join(outputDirectory, 'comparison-report.md'),
      join(outputDirectory, 'demo-result.json'),
      ...persistedFiles,
    ].map((path) => readFile(path, 'utf8')),
  );
  for (const contents of text) {
    assert.equal(
      contents.includes(cleanRoot),
      false,
      'Artifacts must not expose the checkout path',
    );
    assert.equal(contents.includes('pseudo-secret'), false, 'Artifacts must not expose secrets');
  }
}

try {
  await cp(repositoryRoot, cleanRoot, {
    recursive: true,
    filter: (source) => {
      const path = relative(repositoryRoot, source).replaceAll('\\', '/');
      return (
        path !== 'node_modules' &&
        !path.startsWith('node_modules/') &&
        path !== 'dist' &&
        !path.startsWith('dist/') &&
        path !== 'coverage' &&
        !path.startsWith('coverage/') &&
        path !== '.git' &&
        !path.startsWith('.git/') &&
        path !== 'artifacts' &&
        !path.startsWith('artifacts/')
      );
    },
  });
  await mkdir(join(cleanRoot, 'artifacts'));

  runNpm(['ci', '--no-audit', '--no-fund']);
  runNpm(['run', 'build']);
  const packageJson = JSON.parse(await readFile(join(cleanRoot, 'package.json'), 'utf8'));

  const help = runNpm(['start', '--', '--help']);
  assert.match(help.stdout, /Usage: agent-harness/);
  const version = runNpm(['start', '--', '--version']);
  assert.equal(version.stdout.trim().split(/\r?\n/).at(-1), packageJson.version);

  const demo = runNpm(['run', 'dev', '--', 'demo', '--output', './artifacts/fresh-demo']);
  assert.match(demo.stdout, /Demo completed\./);
  const result = JSON.parse(await readFile(join(outputDirectory, 'demo-result.json'), 'utf8'));
  await assertDemoArtifacts(result);

  const baselineReplay = runNpm([
    'start',
    '--',
    'replay',
    '--demo',
    './artifacts/fresh-demo',
    '--variant',
    'baseline',
    '--case',
    'repo-qa-01',
  ]);
  assert.match(baselineReplay.stdout, /Score passed: true/);

  const ablationReplay = runNpm([
    'start',
    '--',
    'replay',
    '--demo',
    './artifacts/fresh-demo',
    '--variant',
    'ablation',
    '--case',
    'repo-qa-01',
  ]);
  assert.match(ablationReplay.stdout, /Score passed: false/);

  console.log('Fresh environment validation passed.');
  console.log(`Validation timings: ${JSON.stringify(timings)}`);
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}
