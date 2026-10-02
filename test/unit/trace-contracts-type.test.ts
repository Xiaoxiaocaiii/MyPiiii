import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseTraceEvent,
  type RunArtifactDescriptor,
  type RunManifest,
  type TraceEvent,
  type TraceEventType,
} from '../../src/observability/trace-contracts.js';

function eventLabel(event: TraceEvent): string {
  switch (event.eventType) {
    case 'session.started':
      return event.payload.configId;
    case 'context.built':
      return event.payload.context.taskInput;
    case 'model.requested':
      return event.payload.request.sessionId;
    case 'model.responded':
      return String(event.payload.response.schemaVersion);
    case 'tool.requested':
      return event.payload.toolName;
    case 'tool.completed':
      return event.payload.callId;
    case 'tool.failed':
      return event.payload.code;
    case 'turn.completed':
      return String(event.payload.turn.turnIndex);
    case 'session.completed':
      return String(event.payload.turnCount);
    case 'session.failed':
      return event.payload.error.code;
  }
}

describe('observability contract types', () => {
  it('narrows TraceEvent payloads by eventType', () => {
    const event = parseTraceEvent({
      schemaVersion: 1,
      eventId: 'event-1',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 0,
      eventType: 'session.completed',
      timestamp: '2026-09-20T10:00:00.000Z',
      payload: {
        finalOutput: 'Done',
        turnCount: 1,
      },
    });

    expect(eventLabel(event)).toBe('1');
    expectTypeOf(event.eventType).toEqualTypeOf<TraceEventType>();
  });

  it('exposes stable manifest and artifact field types', () => {
    expectTypeOf<RunManifest['status']>().toEqualTypeOf<'completed' | 'failed'>();
    expectTypeOf<RunManifest['artifacts']['trace']>().toEqualTypeOf<RunArtifactDescriptor>();
    expectTypeOf<RunArtifactDescriptor['bytes']>().toBeNumber();
  });
});
