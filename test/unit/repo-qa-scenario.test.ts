import { describe, expect, it } from 'vitest';

import {
  adaptRepoQaInput,
  assertRepoQaToolAllowed,
  isRepoQaToolAllowed,
  parseRepoQaOutput,
  repoQaScenario,
  ScenarioError,
} from '../../src/scenarios/repo-qa.js';

describe('repo-qa scenario', () => {
  it('exposes a stable version and adapts valid input for Runtime', () => {
    expect(repoQaScenario).toEqual({
      schemaVersion: 1,
      scenarioId: 'repo-qa',
      version: 'v1',
      allowedTools: ['project.summary', 'repository.search'],
    });
    expect(adaptRepoQaInput({ question: 'Where is the runtime?' })).toBe(
      'Repository question:\nWhere is the runtime?',
    );
  });

  it('rejects invalid input without exposing the original value', () => {
    const secret = 'password-value';
    let thrown: unknown;
    try {
      adaptRepoQaInput({ question: secret, unexpected: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new ScenarioError('SCENARIO_INPUT_INVALID'));
    expect(String(thrown)).not.toContain(secret);
    expect(() => adaptRepoQaInput({ question: '   ' })).toThrowError(
      new ScenarioError('SCENARIO_INPUT_INVALID'),
    );
  });

  it('accepts only the fixed output contract', () => {
    expect(parseRepoQaOutput({ answer: 'The runtime is in src/core/runtime.ts.' })).toEqual({
      answer: 'The runtime is in src/core/runtime.ts.',
    });
    expect(() => parseRepoQaOutput({ answer: '' })).toThrowError(
      new ScenarioError('SCENARIO_OUTPUT_INVALID'),
    );
    expect(() => parseRepoQaOutput({ summary: 'wrong shape' })).toThrowError(
      new ScenarioError('SCENARIO_OUTPUT_INVALID'),
    );
  });

  it('enforces the declared read-only tool boundary', () => {
    expect(isRepoQaToolAllowed('repository.search')).toBe(true);
    expect(isRepoQaToolAllowed('project.summary')).toBe(true);
    expect(isRepoQaToolAllowed('shell.exec')).toBe(false);
    expect(isRepoQaToolAllowed('repository/search')).toBe(false);
    expect(() => assertRepoQaToolAllowed('repository.search')).not.toThrow();
    expect(() => assertRepoQaToolAllowed('shell.exec')).toThrowError(
      new ScenarioError('SCENARIO_TOOL_NOT_ALLOWED'),
    );
  });
});
