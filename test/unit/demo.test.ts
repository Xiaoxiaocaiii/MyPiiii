import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DemoError, demoResultSchema, runDemo, runDemoCommand } from '../../src/eval/demo.js';

describe('deterministic CLI demo', () => {
  it('runs both configurations and writes versioned result artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-'));
    const outputDirectory = join(root, 'output');

    try {
      const result = await runDemo({
        outputDirectory,
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      });

      expect(demoResultSchema.safeParse(result).success).toBe(true);
      expect(result.baseline.run.samples).toHaveLength(20);
      expect(result.ablation.run.samples).toHaveLength(20);
      expect(result.baseline.metrics.scorePassRate).toBe(1);
      expect(result.report.regressions.map((change) => change.caseId)).toEqual(['repo-qa-01']);
      expect(result.report.unavailableMetrics).toContain('tokenUsage');
      expect(result.report.unavailableMetrics).toContain('cost');

      const report = await readFile(join(outputDirectory, 'comparison-report.md'), 'utf8');
      const machineResult = await readFile(join(outputDirectory, 'demo-result.json'), 'utf8');
      expect(report).toContain('# Eval Comparison Report');
      expect(machineResult).toContain('"schemaVersion": 1');
      expect(machineResult).not.toContain(outputDirectory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints experiment results and Trace references from the command handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-command-'));
    const outputDirectory = join(root, 'output');
    const output: string[] = [];

    try {
      await runDemoCommand(['--output', outputDirectory], (message) => output.push(message));

      expect(output.join('\n')).toContain('Dataset: repo-qa-structure@v1');
      expect(output.join('\n')).toContain('Regression samples: repo-qa-01');
      expect(output.join('\n')).toContain('Unavailable metrics:');
      expect(output.join('\n')).toContain('Failure Trace refs:');
      expect(output.join('\n')).toContain('comparison-report.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid arguments, existing output, and invalid artifact parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-errors-'));
    const outputDirectory = join(root, 'output');
    const fileParent = join(root, 'not-a-directory');

    try {
      await expect(runDemoCommand([], () => undefined)).rejects.toEqual(
        new DemoError('DEMO_ARGUMENTS_INVALID'),
      );

      await writeFile(fileParent, 'not a directory');
      await expect(runDemo({ outputDirectory: join(fileParent, 'child') })).rejects.toEqual(
        new DemoError('DEMO_ARTIFACT_FAILED'),
      );

      await runDemo({ outputDirectory, createdAt: new Date('2026-09-28T10:00:00.000Z') });
      await expect(
        runDemo({ outputDirectory, createdAt: new Date('2026-09-28T10:00:00.000Z') }),
      ).rejects.toEqual(new DemoError('DEMO_OUTPUT_EXISTS'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
