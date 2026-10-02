import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = resolve('.');
const npmCliPath =
  process.env.npm_execpath ??
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const validationRoot = await mkdtemp(join(tmpdir(), 'agent-harness-install-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
  );
  return result;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCliPath, ...args], cwd);
}

try {
  runNpm(['pack', '--json', '--pack-destination', validationRoot], repositoryRoot);

  const packageArchive = join(
    validationRoot,
    `${packageJson.name.replaceAll('/', '-')}-${packageJson.version}.tgz`,
  );
  const installRoot = join(validationRoot, 'clean-install');
  await mkdir(installRoot);

  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', packageArchive], installRoot);

  const executable = join(installRoot, 'node_modules', packageJson.name, 'dist', 'bin.js');
  const help = run(process.execPath, [executable, '--help'], installRoot);
  assert.match(help.stdout, /Usage: agent-harness/);

  const version = run(process.execPath, [executable, '--version'], installRoot);
  assert.equal(version.stdout.trim(), packageJson.version);
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}

console.log('Clean installation validation passed.');
