import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const executable = resolve('dist/bin.js');

function execute(args) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8',
  });
}

const help = execute(['--help']);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage: agent-harness/);

const version = execute(['--version']);
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /^0\.1\.0\s*$/);

const unknown = execute(['--unknown']);
assert.equal(unknown.status, 1);
assert.match(unknown.stdout, /Unknown option: --unknown/);

console.log('Integration smoke test passed.');
