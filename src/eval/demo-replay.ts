import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { artifactRelativePathSchema } from '../observability/trace-contracts.js';
import { analyzeTraceConsistency } from '../observability/trace-consistency.js';
import { replayTraceRun } from '../observability/trace-replay.js';
import { loadTraceRun } from '../observability/trace-loader.js';
import { demoResultSchema, type DemoResult } from './demo.js';

export type DemoReplayErrorCode =
  | 'DEMO_REPLAY_ARGUMENTS_INVALID'
  | 'DEMO_REPLAY_RESULT_INVALID'
  | 'DEMO_REPLAY_CASE_NOT_FOUND'
  | 'DEMO_REPLAY_PATH_INVALID'
  | 'DEMO_REPLAY_ARTIFACT_MISSING';

const errorMessages: Record<DemoReplayErrorCode, string> = {
  DEMO_REPLAY_ARGUMENTS_INVALID: 'The replay arguments are invalid',
  DEMO_REPLAY_RESULT_INVALID: 'The demo result is invalid',
  DEMO_REPLAY_CASE_NOT_FOUND: 'The requested demo case was not found',
  DEMO_REPLAY_PATH_INVALID: 'The demo trace path is invalid',
  DEMO_REPLAY_ARTIFACT_MISSING: 'The demo replay artifact is missing',
};

export class DemoReplayError extends Error {
  override readonly name = 'DemoReplayError';
  readonly code: DemoReplayErrorCode;

  constructor(code: DemoReplayErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export async function replayDemoCommand(
  args: readonly string[],
  write: (message: string) => void,
): Promise<void> {
  const options = parseReplayArguments(args);
  const demoDirectory = resolve(options.demoDirectory);
  const result = await loadDemoResult(demoDirectory);
  const run = result[options.variant];
  const sample = run.run.samples.find((candidate) => candidate.caseId === options.caseId);

  if (sample === undefined) {
    throw new DemoReplayError('DEMO_REPLAY_CASE_NOT_FOUND');
  }

  const tracePath = artifactRelativePathSchema.safeParse(sample.tracePath);
  if (!tracePath.success) {
    throw new DemoReplayError('DEMO_REPLAY_PATH_INVALID');
  }

  const variantDirectory = resolve(demoDirectory, options.variant);
  const sessionDirectory = resolve(variantDirectory, dirname(tracePath.data));
  const sessionRelativePath = relative(variantDirectory, sessionDirectory);
  if (
    sessionRelativePath === '' ||
    sessionRelativePath === '..' ||
    sessionRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new DemoReplayError('DEMO_REPLAY_PATH_INVALID');
  }

  const loaded = await loadTraceRun({ sessionDirectory });
  const replay = await replayTraceRun({ sessionDirectory });
  const consistency = analyzeTraceConsistency(loaded);
  const firstIssue = consistency.issues[0];

  write('Replay completed.');
  write(`Case: ${sample.caseId}`);
  write(`Session: ${replay.sessionId}`);
  write(`Status: ${replay.status}`);
  write(`Turns: ${replay.turns.length}`);
  write(`Score passed: ${sample.score?.passed === true}`);
  write(`Failure category: ${sample.failureCategory ?? 'none'}`);
  write(`Failure code: ${replay.failure?.code ?? 'none'}`);
  write(
    `First inconsistency: ${
      firstIssue === undefined ? 'none' : `${firstIssue.code} (${firstIssue.category})`
    }`,
  );
  write(`Trace: ${sample.tracePath}`);
}

interface ReplayArguments {
  readonly demoDirectory: string;
  readonly variant: 'baseline' | 'ablation';
  readonly caseId: string;
}

function parseReplayArguments(args: readonly string[]): ReplayArguments {
  if (args.length !== 6) {
    throw new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID');
  }

  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      (key !== '--demo' && key !== '--variant' && key !== '--case') ||
      value === undefined ||
      value.trim().length === 0 ||
      values.has(key)
    ) {
      throw new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID');
    }
    values.set(key, value);
  }

  const demoDirectory = values.get('--demo');
  const variant = values.get('--variant');
  const caseId = values.get('--case');
  if (
    demoDirectory === undefined ||
    caseId === undefined ||
    (variant !== 'baseline' && variant !== 'ablation')
  ) {
    throw new DemoReplayError('DEMO_REPLAY_ARGUMENTS_INVALID');
  }

  return { demoDirectory, variant, caseId };
}

async function loadDemoResult(demoDirectory: string): Promise<DemoResult> {
  let contents: string;
  try {
    contents = await readFile(resolve(demoDirectory, 'demo-result.json'), 'utf8');
  } catch {
    throw new DemoReplayError('DEMO_REPLAY_ARTIFACT_MISSING');
  }

  try {
    return demoResultSchema.parse(JSON.parse(contents) as unknown);
  } catch {
    throw new DemoReplayError('DEMO_REPLAY_RESULT_INVALID');
  }
}
