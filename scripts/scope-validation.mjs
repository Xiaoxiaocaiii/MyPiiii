import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const forbiddenPackages = new Set([
  'express',
  'fastify',
  'hono',
  'koa',
  'next',
  'react',
  'react-dom',
  'svelte',
  'vite',
  'vue',
]);
const declaredPackages = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
];

assert.deepEqual(
  declaredPackages.filter((name) => forbiddenPackages.has(name)),
  [],
  'Web/API or frontend dependencies must not be introduced',
);

const sourceDirectories = await readdir(join(root, 'src'), { withFileTypes: true });
const forbiddenDirectories = new Set(['api', 'frontend', 'server', 'web']);
assert.deepEqual(
  sourceDirectories
    .filter((entry) => entry.isDirectory() && forbiddenDirectories.has(entry.name))
    .map((entry) => entry.name),
  [],
  'Web/API source directories must not be introduced',
);

const cli = spawnSync(process.execPath, [join(root, 'dist', 'bin.js'), '--help'], {
  encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /demo\s+Run the deterministic/);
assert.match(cli.stdout, /replay\s+Replay a demo case/);

console.log(
  'Web/API scope validation passed: no web framework, HTTP service, or frontend entrypoint.',
);
