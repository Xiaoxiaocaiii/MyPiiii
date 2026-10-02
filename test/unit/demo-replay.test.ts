import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDemo } from '../../src/eval/demo.js';
import { DemoReplayError, replayDemoCommand } from '../../src/eval/demo-replay.js';

describe('demo replay CLI command', () => {
  it('replays a normal sample and a regression sample offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-replay-'));
    const outputDirectory = join(root, 'output');

    try {
      await runDemo({
        outputDirectory,
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      });

      const baselineOutput: string[] = [];
      await replayDemoCommand(
        ['--demo', outputDirectory, '--variant', 'baseline', '--case', 'repo-qa-01'],
        (message) => baselineOutput.push(message),
      );
      expect(baselineOutput.join('\n')).toContain('Status: completed');
      expect(baselineOutput.join('\n')).toContain('Score passed: true');
      expect(baselineOutput.join('\n')).toContain('Failure category: none');
      expect(baselineOutput.join('\n')).toContain('First inconsistency: none');

      const ablationOutput: string[] = [];
      await replayDemoCommand(
        ['--demo', outputDirectory, '--variant', 'ablation', '--case', 'repo-qa-01'],
        (message) => ablationOutput.push(message),
      );
      expect(ablationOutput.join('\n')).toContain('Status: completed');
      expect(ablationOutput.join('\n')).toContain('Score passed: false');
      expect(ablationOutput.join('\n')).toContain(
        'Trace: 2026-09-28/ablation-repo-qa-01/trace.jsonl',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid arguments, missing cases, corrupt results, and missing traces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mypiiii-demo-replay-errors-'));
    const outputDirectory = join(root, 'output');

    try {
      await expect(replayDemoCommand([], () => undefined)).rejects.toEqual(
        new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID'),
      );
      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--variant', 'unknown', '--case', 'repo-qa-01'],
          () => undefined,
        ),
      ).rejects.toEqual(new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID'));
      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--demo', outputDirectory, '--case', 'repo-qa-01'],
          () => undefined,
        ),
      ).rejects.toEqual(new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID'));
      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--variant', 'baseline', '--case', 'repo-qa-01'],
          () => undefined,
        ),
      ).rejects.toEqual(new DemoReplayError('DEMO_REPLAY_ARTIFACT_MISSING'));
      await runDemo({
        outputDirectory,
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      });

      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--variant', 'baseline', '--case', 'missing-case'],
          () => undefined,
        ),
      ).rejects.toEqual(new DemoReplayError('DEMO_REPLAY_CASE_NOT_FOUND'));

      const resultPath = join(outputDirectory, 'demo-result.json');
      const originalResult = await readFile(resultPath, 'utf8');
      await writeFile(resultPath, '{"schemaVersion":2}\n', 'utf8');
      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--variant', 'baseline', '--case', 'repo-qa-01'],
          () => undefined,
        ),
      ).rejects.toEqual(new DemoReplayError('DEMO_REPLAY_RESULT_INVALID'));
      await writeFile(resultPath, originalResult, 'utf8');

      await rm(join(outputDirectory, 'baseline', '2026-09-28', 'baseline-repo-qa-01'), {
        recursive: true,
        force: true,
      });
      await expect(
        replayDemoCommand(
          ['--demo', outputDirectory, '--variant', 'baseline', '--case', 'repo-qa-01'],
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'TRACE_ARTIFACT_MISSING' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
