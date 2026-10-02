import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  agentActionSchema,
  observationSchema,
  sessionSchema,
  turnSchema,
  type AgentAction,
  type Observation,
  type Session,
  type Turn,
} from '../../src/core/contracts.js';

function roundTrip<T>(schema: ZodType<T>, value: T): T {
  const serialized = JSON.stringify(value);
  return schema.parse(JSON.parse(serialized) as unknown);
}

const session: Session = {
  schemaVersion: 1,
  sessionId: 'session-1',
  scenarioId: 'repo-qa',
  configId: 'baseline',
  status: 'created',
  createdAt: '2026-09-17T09:00:00.000Z',
};

const toolCall: AgentAction = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-1',
  toolName: 'read-file',
  args: { path: 'README.md' },
};

const toolResult: Observation = {
  schemaVersion: 1,
  type: 'tool_result',
  callId: 'call-1',
  toolName: 'read-file',
  data: { content: 'example' },
  truncated: false,
  durationMs: 12,
};

describe('core contract serialization', () => {
  it('round-trips a Session', () => {
    expect(roundTrip(sessionSchema, session)).toEqual(session);
  });

  it('round-trips a Turn with an action and observation', () => {
    const turn: Turn = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      turnIndex: 0,
      inputMessage: 'Summarize the repository.',
      modelResponse: { type: 'tool_call' },
      action: toolCall,
      observations: [toolResult],
    };

    expect(roundTrip(turnSchema, turn)).toEqual(turn);
  });

  it.each<AgentAction>([
    toolCall,
    {
      schemaVersion: 1,
      type: 'final_answer',
      content: { summary: 'Done' },
    },
    {
      schemaVersion: 1,
      type: 'invalid',
      reason: 'Missing action type',
      raw: { content: 'unstructured' },
    },
  ])('round-trips AgentAction type $type', (action) => {
    expect(roundTrip(agentActionSchema, action)).toEqual(action);
  });

  it.each<Observation>([
    toolResult,
    {
      schemaVersion: 1,
      type: 'tool_error',
      callId: 'call-2',
      toolName: 'read-file',
      code: 'PERMISSION_DENIED',
      message: 'Access denied',
      retryable: false,
      durationMs: 2,
    },
  ])('round-trips Observation type $type', (observation) => {
    expect(roundTrip(observationSchema, observation)).toEqual(observation);
  });
});

describe('core contract validation', () => {
  it.each([
    {
      name: 'unknown session status',
      schema: sessionSchema,
      value: { ...session, status: 'paused' },
    },
    {
      name: 'invalid session timestamp',
      schema: sessionSchema,
      value: { ...session, createdAt: 'yesterday' },
    },
    {
      name: 'negative turn index',
      schema: turnSchema,
      value: {
        schemaVersion: 1,
        sessionId: session.sessionId,
        turnIndex: -1,
        inputMessage: 'Invalid',
      },
    },
    {
      name: 'mismatched action fields',
      schema: agentActionSchema,
      value: {
        schemaVersion: 1,
        type: 'final_answer',
        callId: 'call-1',
        content: 'Done',
      },
    },
    {
      name: 'mismatched observation fields',
      schema: observationSchema,
      value: {
        schemaVersion: 1,
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'read-file',
        code: 'EXECUTION_FAILED',
        durationMs: 1,
      },
    },
  ])('rejects $name', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    {
      name: 'undefined final content',
      schema: agentActionSchema,
      value: { schemaVersion: 1, type: 'final_answer', content: undefined },
    },
    {
      name: 'BigInt tool arguments',
      schema: agentActionSchema,
      value: {
        schemaVersion: 1,
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'read-file',
        args: 1n,
      },
    },
    {
      name: 'function invalid-action payload',
      schema: agentActionSchema,
      value: {
        schemaVersion: 1,
        type: 'invalid',
        reason: 'Invalid payload',
        raw: () => undefined,
      },
    },
    {
      name: 'non-finite observation data',
      schema: observationSchema,
      value: { ...toolResult, data: Number.POSITIVE_INFINITY },
    },
    {
      name: 'non-JSON model response',
      schema: turnSchema,
      value: {
        schemaVersion: 1,
        sessionId: session.sessionId,
        turnIndex: 0,
        inputMessage: 'Invalid',
        modelResponse: new Date(),
      },
    },
  ])('rejects $name', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects cyclic data', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      observationSchema.safeParse({
        ...toolResult,
        data: cyclic,
      }).success,
    ).toBe(false);
  });
});
