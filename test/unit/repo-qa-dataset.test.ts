import { describe, expect, it } from 'vitest';

import { loadRepoQaDataset, repoQaDataset } from '../../src/eval/repo-qa-dataset.js';

describe('repo-qa dataset', () => {
  it('provides a versioned 20-case dataset for one scenario', () => {
    expect(repoQaDataset.schemaVersion).toBe(1);
    expect(repoQaDataset.datasetId).toBe('repo-qa-structure');
    expect(repoQaDataset.version).toBe('v1');
    expect(repoQaDataset.scenarioId).toBe('repo-qa');
    expect(repoQaDataset.scenarioVersion).toBe('v1');
    expect(repoQaDataset.cases).toHaveLength(20);
    expect(new Set(repoQaDataset.cases.map((evalCase) => evalCase.caseId)).size).toBe(20);
  });

  it('contains stable inputs, expected outputs, labels, and rules', () => {
    const first = repoQaDataset.cases[0]!;
    const last = repoQaDataset.cases.at(-1)!;

    expect(first).toMatchObject({
      caseId: 'repo-qa-01',
      input: { question: 'Where is the main Runtime implementation?' },
      expected: { answer: 'src/core/runtime.ts' },
      tags: ['runtime', 'structure'],
      scoringRules: [{ ruleId: 'exact-answer', type: 'exact_match' }],
    });
    expect(last.caseId).toBe('repo-qa-20');
    expect(last.expected).toEqual({ answer: 'src/cli.ts' });
    expect(repoQaDataset.cases.every((evalCase) => evalCase.scoringRules.length > 0)).toBe(true);
  });

  it('reloads deterministically without sharing mutations', () => {
    const firstLoad = loadRepoQaDataset();
    const secondLoad = loadRepoQaDataset();

    expect(secondLoad).toEqual(firstLoad);
    firstLoad.cases[0]!.tags.push('local-only');
    expect(secondLoad.cases[0]!.tags).not.toContain('local-only');
  });

  it('round-trips as JSON without changing the dataset', () => {
    expect(JSON.parse(JSON.stringify(repoQaDataset))).toEqual(repoQaDataset);
  });
});
