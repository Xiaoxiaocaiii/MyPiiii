import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  configErrorCodes,
  loadExperimentConfig,
} from '../../src/core/config-loader.js';

const validConfig = {
  configId: 'baseline',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
  },
};

describe('loadExperimentConfig', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-harness-config-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeConfig(value: unknown): Promise<string> {
    const configPath = join(directory, 'experiment.json');
    await writeFile(configPath, JSON.stringify(value), 'utf8');
    return configPath;
  }

  it('loads and validates a JSON configuration file', async () => {
    const configPath = await writeConfig(validConfig);

    const config = await loadExperimentConfig({ configPath, env: {} });

    expect(config.configId).toBe('baseline');
    expect(config.runtime.maxTurns).toBe(8);
  });

  it('applies environment values after file values', async () => {
    const configPath = await writeConfig({
      ...validConfig,
      artifacts: { directory: './from-file' },
    });

    const config = await loadExperimentConfig({
      configPath,
      env: { ARTIFACTS_DIR: './from-environment' },
    });

    expect(config.artifacts.directory).toBe('./from-environment');
  });

  it.each([
    { name: 'a string', artifacts: 'invalid' },
    { name: 'an array', artifacts: [] },
    { name: 'null', artifacts: null },
  ])(
    'does not let environment values hide artifacts configured as $name',
    async ({ artifacts }) => {
      const configPath = await writeConfig({
        ...validConfig,
        artifacts,
      });

      await expect(
        loadExperimentConfig({
          configPath,
          env: { ARTIFACTS_DIR: './from-environment' },
        }),
      ).rejects.toMatchObject({
        code: configErrorCodes.validationError,
      });
    },
  );

  it('returns CONFIG_NOT_FOUND for a missing file', async () => {
    const promise = loadExperimentConfig({
      configPath: join(directory, 'missing.json'),
      env: {},
    });

    await expect(promise).rejects.toMatchObject({
      name: 'ConfigError',
      code: configErrorCodes.notFound,
    });
  });

  it('returns CONFIG_PARSE_ERROR for invalid JSON', async () => {
    const configPath = join(directory, 'invalid.json');
    await writeFile(configPath, '{invalid', 'utf8');

    await expect(loadExperimentConfig({ configPath, env: {} })).rejects.toMatchObject({
      code: configErrorCodes.parseError,
    });
  });

  it.each([
    { name: 'missing required field', value: { ...validConfig, configId: undefined } },
    {
      name: 'invalid value',
      value: { ...validConfig, runtime: { maxTurns: -1 } },
    },
  ])('returns CONFIG_VALIDATION_ERROR for $name', async ({ value }) => {
    const configPath = await writeConfig(value);

    await expect(loadExperimentConfig({ configPath, env: {} })).rejects.toBeInstanceOf(ConfigError);
    await expect(loadExperimentConfig({ configPath, env: {} })).rejects.toMatchObject({
      code: configErrorCodes.validationError,
    });
  });

  it('does not include rejected values in validation messages', async () => {
    const secret = 'secret-value-that-must-not-leak';
    const configPath = await writeConfig({
      ...validConfig,
      model: { ...validConfig.model, temperature: secret },
    });

    await expect(loadExperimentConfig({ configPath, env: {} })).rejects.not.toThrow(secret);
  });
});
