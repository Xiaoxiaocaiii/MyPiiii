import { describe, expect, it } from 'vitest';

import { DeterministicScorerError, scoreEvalCase } from '../../src/eval/deterministic-scorer.js';
import type { EvalCase } from '../../src/eval/eval-contracts.js';
import type { ReplayResult } from '../../src/observability/trace-replay.js';
import type { JsonValue } from '../../src/core/contracts.js';

const replay: ReplayResult = {
  schemaVersion: 1,
  sessionId: 'session-1',
  status: 'completed',
  createdAt: '2026-09-27T10:00:00.000Z',
  completedAt: '2026-09-27T10:00:01.000Z',
  turns: [
    {
      turnIndex: 0,
      inputMessage: 'Find the runtime.',
      modelOutput: { answer: 'src/core/runtime.ts' },
      action: {
        schemaVersion: 1,
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'repository.search',
        args: { redacted: true },
      },
      observations: [],
    },
  ],
  finalOutput: { answer: 'src/core/runtime.ts' },
  eventEvidence: [
    {
      eventId: 'event-1',
      sequence: 1,
      timestamp: '2026-09-27T10:00:00.500Z',
    },
  ],
};

function caseWithRules(
  scoringRules: EvalCase['scoringRules'],
  expected: JsonValue = { answer: 'src/core/runtime.ts' },
): EvalCase {
  return {
    schemaVersion: 1,
    caseId: 'repo-qa-01',
    input: { question: 'Where is the main Runtime implementation?' },
    expected,
    tags: ['runtime'],
    scoringRules,
  };
}

describe('deterministic scorer', () => {
  it('scores exact output, schema, required fields, and tool rules from Replay', () => {
    const result = scoreEvalCase({
      evalCase: caseWithRules([
        { ruleId: 'exact', type: 'exact_match' },
        { ruleId: 'schema', type: 'schema_valid' },
        {
          ruleId: 'fields',
          type: 'required_fields_present',
          parameters: { fields: ['answer'] },
        },
        {
          ruleId: 'expected-tool',
          type: 'expected_tool_used',
          parameters: { toolName: 'repository.search' },
        },
        {
          ruleId: 'forbidden-tool',
          type: 'forbidden_tool_not_used',
          parameters: { toolName: 'shell.exec' },
        },
      ]),
      replay,
      tracePath: 'trace.jsonl',
    });

    expect(result).toMatchObject({
      caseId: 'repo-qa-01',
      sessionId: 'session-1',
      tracePath: 'trace.jsonl',
      status: 'completed',
      score: { passed: true, score: 1 },
    });
    expect(result.score?.rules.every((rule) => rule.passed)).toBe(true);
  });

  it('records failed rules and preserves the Trace reference', () => {
    const result = scoreEvalCase({
      evalCase: caseWithRules([{ ruleId: 'exact', type: 'exact_match' }], {
        answer: 'src/other.ts',
      }),
      replay,
      tracePath: '2026-09-27/session-1/trace.jsonl',
    });

    expect(result.score).toMatchObject({
      passed: false,
      score: 0,
      rules: [{ ruleId: 'exact', passed: false, score: 0 }],
    });
    expect(result.tracePath).toBe('2026-09-27/session-1/trace.jsonl');
  });

  it('records failure code and attribution without replaying dependencies', () => {
    const failedReplay: ReplayResult = {
      ...replay,
      status: 'failed',
      finalOutput: undefined,
      failure: {
        code: 'MODEL_CALL_FAILED',
        message: 'The model call failed',
      },
    };

    const result = scoreEvalCase({
      evalCase: caseWithRules([{ ruleId: 'exact', type: 'exact_match' }]),
      replay: failedReplay,
      tracePath: 'trace.jsonl',
    });

    expect(result).toMatchObject({
      status: 'failed',
      failureCode: 'MODEL_CALL_FAILED',
      failureCategory: 'model',
      score: { passed: false, score: 0 },
    });
  });

  it('rejects invalid cases, Replay values, Trace paths, and rule parameters', () => {
    expect(() =>
      scoreEvalCase({
        evalCase: { ...caseWithRules([{ ruleId: 'exact', type: 'exact_match' }]), caseId: '' },
        replay,
        tracePath: 'trace.jsonl',
      }),
    ).toThrowError(new DeterministicScorerError('EVAL_SCORER_CASE_INVALID'));
    expect(() =>
      scoreEvalCase({
        evalCase: caseWithRules([{ ruleId: 'exact', type: 'exact_match' }]),
        replay: { ...replay, sessionId: '' },
        tracePath: 'trace.jsonl',
      }),
    ).toThrowError(new DeterministicScorerError('EVAL_SCORER_REPLAY_INVALID'));
    expect(() =>
      scoreEvalCase({
        evalCase: caseWithRules([{ ruleId: 'exact', type: 'exact_match' }]),
        replay,
        tracePath: '../trace.jsonl',
      }),
    ).toThrowError(new DeterministicScorerError('EVAL_SCORER_TRACE_PATH_INVALID'));
    expect(() =>
      scoreEvalCase({
        evalCase: caseWithRules([
          {
            ruleId: 'fields',
            type: 'required_fields_present',
            parameters: { fields: [] },
          },
        ]),
        replay,
        tracePath: 'trace.jsonl',
      }),
    ).toThrowError(new DeterministicScorerError('EVAL_SCORER_RULE_INVALID'));
  });
});
