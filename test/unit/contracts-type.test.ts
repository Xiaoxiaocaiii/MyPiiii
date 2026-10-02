import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentAction,
  JsonValue,
  Observation,
  Session,
  Turn,
} from '../../src/core/contracts.js';

function actionLabel(action: AgentAction): string {
  switch (action.type) {
    case 'tool_call':
      return action.toolName;
    case 'final_answer':
      return 'final';
    case 'invalid':
      return action.reason;
  }
}

function observationLabel(observation: Observation): string {
  return observation.type === 'tool_result' ? observation.toolName : observation.code;
}

describe('core contract types', () => {
  it('narrows AgentAction by its discriminator', () => {
    const action: AgentAction = {
      schemaVersion: 1,
      type: 'tool_call',
      callId: 'call-1',
      toolName: 'read-file',
      args: {},
    };

    expect(actionLabel(action)).toBe('read-file');
    expectTypeOf(action.args).toEqualTypeOf<JsonValue>();
  });

  it('narrows Observation by its discriminator', () => {
    const observation: Observation = {
      schemaVersion: 1,
      type: 'tool_error',
      callId: 'call-1',
      toolName: 'read-file',
      code: 'PERMISSION_DENIED',
      message: 'Access denied',
      retryable: false,
      durationMs: 1,
    };

    expect(observationLabel(observation)).toBe('PERMISSION_DENIED');
    expectTypeOf(observation.retryable).toBeBoolean();
  });

  it('exposes stable Session and Turn field types', () => {
    expectTypeOf<Session['status']>().toEqualTypeOf<
      'created' | 'running' | 'completed' | 'failed'
    >();
    expectTypeOf<Turn['turnIndex']>().toBeNumber();
    expectTypeOf<Turn['observations']>().toEqualTypeOf<Observation[]>();
  });
});
