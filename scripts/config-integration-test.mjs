import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, configErrorCodes, loadExperimentConfig } from '../dist/core/config-loader.js';

const directory = await mkdtemp(join(tmpdir(), 'agent-harness-config-integration-'));

try {
  const configPath = join(directory, 'experiment.json');
  await writeFile(
    configPath,
    JSON.stringify({
      configId: 'integration',
      scenarioId: 'repo-qa',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
      },
      artifacts: {
        directory: './from-file',
      },
    }),
    'utf8',
  );

  const config = await loadExperimentConfig({
    configPath,
    env: { ARTIFACTS_DIR: './from-environment' },
  });

  assert.equal(config.configId, 'integration');
  assert.equal(config.artifacts.directory, './from-environment');

  const invalidConfigPath = join(directory, 'invalid-structure.json');
  await writeFile(
    invalidConfigPath,
    JSON.stringify({
      configId: 'integration',
      scenarioId: 'repo-qa',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
      },
      artifacts: 'invalid',
    }),
    'utf8',
  );

  await assert.rejects(
    loadExperimentConfig({
      configPath: invalidConfigPath,
      env: { ARTIFACTS_DIR: './from-environment' },
    }),
    (error) => error instanceof ConfigError && error.code === configErrorCodes.validationError,
  );

  await assert.rejects(
    loadExperimentConfig({
      configPath: join(directory, 'missing.json'),
      env: {},
    }),
    (error) => error instanceof ConfigError && error.code === configErrorCodes.notFound,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Configuration integration test passed.');
