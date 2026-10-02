import { describe, expect, it } from 'vitest';

import { experimentConfigSchema } from '../../src/core/config.js';

const minimalConfig = {
  configId: 'baseline',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
  },
};

describe('experimentConfigSchema', () => {
  it('applies deterministic defaults to a minimal valid config', () => {
    expect(experimentConfigSchema.parse(minimalConfig)).toEqual({
      schemaVersion: 1,
      configId: 'baseline',
      scenarioId: 'repo-qa',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
        temperature: 0,
        maxOutputTokens: 1024,
      },
      runtime: {
        maxTurns: 8,
        timeoutMs: 120_000,
      },
      tools: {
        enabled: [],
      },
      artifacts: {
        directory: './artifacts',
      },
    });
  });

  it('accepts explicit values at valid boundaries', () => {
    const result = experimentConfigSchema.parse({
      ...minimalConfig,
      model: {
        ...minimalConfig.model,
        temperature: 2,
        maxOutputTokens: 1,
      },
      runtime: {
        maxTurns: 1,
        timeoutMs: 1,
      },
      tools: {
        enabled: ['read-file'],
      },
      artifacts: {
        directory: './custom-artifacts',
      },
    });

    expect(result.model.temperature).toBe(2);
    expect(result.runtime.maxTurns).toBe(1);
  });

  it.each([
    { name: 'missing config id', value: { ...minimalConfig, configId: undefined } },
    {
      name: 'invalid identifier',
      value: { ...minimalConfig, scenarioId: 'contains spaces' },
    },
    {
      name: 'temperature above limit',
      value: { ...minimalConfig, model: { ...minimalConfig.model, temperature: 2.1 } },
    },
    {
      name: 'non-positive max turns',
      value: { ...minimalConfig, runtime: { maxTurns: 0 } },
    },
    {
      name: 'unknown field',
      value: { ...minimalConfig, apiKey: 'must-not-be-accepted' },
    },
  ])('rejects $name', ({ value }) => {
    expect(experimentConfigSchema.safeParse(value).success).toBe(false);
  });
});
