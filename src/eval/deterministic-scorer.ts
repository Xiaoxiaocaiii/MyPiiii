import { z } from 'zod';

import {
  evalCaseSchema,
  evalScoreResultSchema,
  type EvalCase,
  type EvalSampleResult,
  type EvalRuleResult,
  type EvalScoreResult,
} from './eval-contracts.js';
import { parseRepoQaOutput } from '../scenarios/repo-qa.js';
import { replayResultSchema, type ReplayResult } from '../observability/trace-replay.js';

const requiredFieldsParametersSchema = z.strictObject({
  fields: z.array(z.string().trim().min(1)).min(1),
});

const toolParametersSchema = z.strictObject({
  toolName: z.string().trim().min(1),
});

export type DeterministicScorerErrorCode =
  | 'EVAL_SCORER_CASE_INVALID'
  | 'EVAL_SCORER_REPLAY_INVALID'
  | 'EVAL_SCORER_TRACE_PATH_INVALID'
  | 'EVAL_SCORER_RULE_INVALID';

const errorMessages: Record<DeterministicScorerErrorCode, string> = {
  EVAL_SCORER_CASE_INVALID: 'The evaluation case cannot be scored',
  EVAL_SCORER_REPLAY_INVALID: 'The replay result cannot be scored',
  EVAL_SCORER_TRACE_PATH_INVALID: 'The trace reference is invalid',
  EVAL_SCORER_RULE_INVALID: 'The scoring rule parameters are invalid',
};

export class DeterministicScorerError extends Error {
  override readonly name = 'DeterministicScorerError';
  readonly code: DeterministicScorerErrorCode;

  constructor(code: DeterministicScorerErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface ScoreEvalCaseOptions {
  readonly evalCase: EvalCase;
  readonly replay: ReplayResult;
  readonly tracePath: string;
}

export function scoreEvalCase(options: ScoreEvalCaseOptions): EvalSampleResult {
  const evalCase = parseEvalCaseOrThrow(options.evalCase);
  const replay = parseReplayOrThrow(options.replay);
  const tracePath = parseTracePath(options.tracePath);
  const rules = evalCase.scoringRules.map((rule) => scoreRule(rule, evalCase, replay));
  const score = createScore(rules);

  return {
    schemaVersion: 1,
    caseId: evalCase.caseId,
    sessionId: replay.sessionId,
    tracePath,
    status: replay.status,
    score,
    ...(replay.failure === undefined
      ? {}
      : {
          failureCode: replay.failure.code,
          failureCategory: categoryForFailure(replay.failure.code),
        }),
  };
}

function parseEvalCaseOrThrow(value: unknown): EvalCase {
  const result = evalCaseSchema.safeParse(value);
  if (!result.success) {
    throw new DeterministicScorerError('EVAL_SCORER_CASE_INVALID');
  }
  return result.data;
}

function parseReplayOrThrow(value: unknown): ReplayResult {
  const result = replayResultSchema.safeParse(value);
  if (!result.success) {
    throw new DeterministicScorerError('EVAL_SCORER_REPLAY_INVALID');
  }
  return result.data;
}

function parseTracePath(value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes(':') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new DeterministicScorerError('EVAL_SCORER_TRACE_PATH_INVALID');
  }
  return value;
}

function scoreRule(
  rule: EvalCase['scoringRules'][number],
  evalCase: EvalCase,
  replay: ReplayResult,
): EvalRuleResult {
  let passed: boolean;

  switch (rule.type) {
    case 'exact_match':
      passed = replay.status === 'completed' && sameJson(replay.finalOutput, evalCase.expected);
      break;
    case 'schema_valid':
      passed = replay.status === 'completed' && isRepoQaOutput(replay.finalOutput);
      break;
    case 'required_fields_present':
      passed = hasRequiredFields(replay.finalOutput, rule.parameters);
      break;
    case 'expected_tool_used':
      passed = hasTool(replay, rule.parameters);
      break;
    case 'forbidden_tool_not_used':
      passed = !hasTool(replay, rule.parameters);
      break;
    default:
      throw new DeterministicScorerError('EVAL_SCORER_RULE_INVALID');
  }

  return { ruleId: rule.ruleId, passed, score: passed ? 1 : 0 };
}

function createScore(rules: readonly EvalRuleResult[]): EvalScoreResult {
  const score = rules.reduce((total, rule) => total + rule.score, 0) / rules.length;
  return evalScoreResultSchema.parse({
    schemaVersion: 1,
    passed: rules.every((rule) => rule.passed),
    score,
    rules,
  });
}

function isRepoQaOutput(value: unknown): boolean {
  return parseRepoQaOutputSafe(value);
}

function parseRepoQaOutputSafe(value: unknown): boolean {
  try {
    parseRepoQaOutput(value);
    return true;
  } catch {
    return false;
  }
}

function hasRequiredFields(value: unknown, parameters: unknown): boolean {
  const result = requiredFieldsParametersSchema.safeParse(parameters);
  if (!result.success) {
    throw new DeterministicScorerError('EVAL_SCORER_RULE_INVALID');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return result.data.fields.every((field) => field in value);
}

function hasTool(replay: ReplayResult, parameters: unknown): boolean {
  const result = toolParametersSchema.safeParse(parameters);
  if (!result.success) {
    throw new DeterministicScorerError('EVAL_SCORER_RULE_INVALID');
  }
  return replay.turns.some(
    (turn) => turn.action?.type === 'tool_call' && turn.action.toolName === result.data.toolName,
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function categoryForFailure(code: string): EvalSampleResult['failureCategory'] {
  if (code.startsWith('MODEL_')) return 'model';
  if (code.startsWith('TOOL_')) return 'tool';
  if (code.startsWith('CONTEXT_')) return 'context';
  if (code.startsWith('RUNTIME_') || code === 'MAX_TURNS_EXCEEDED') return 'runtime';
  if (code.startsWith('TRACE_') || code.startsWith('REPLAY_')) return 'trace_integrity';
  return 'unknown';
}
