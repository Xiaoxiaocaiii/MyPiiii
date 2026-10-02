import { describe, expect, it } from 'vitest';

import {
  InMemoryTraceSink,
  TraceRecorder,
  TraceRecorderError,
  type TraceEventInput,
  type TraceSink,
} from '../../src/observability/trace-recorder.js';
import {
  ObservabilityContractError,
  type TraceEvent,
} from '../../src/observability/trace-contracts.js';

const timestamp = new Date('2026-09-20T10:00:00.000Z');

const sessionStarted: TraceEventInput = {
  eventType: 'session.started',
  turnIndex: null,
  payload: {
    configId: 'baseline',
    scenarioId: 'repo-qa',
    model: { provider: 'fake', name: 'deterministic-model' },
    inputMessage: 'Inspect the repository.',
  },
};

const modelRequested: TraceEventInput = {
  eventType: 'model.requested',
  turnIndex: 0,
  payload: {
    request: {
      schemaVersion: 1,
      sessionId: 'session-1',
      turnIndex: 0,
      inputMessage: 'Inspect the repository.',
      model: {
        provider: 'fake',
        name: 'deterministic-model',
        temperature: 0,
        maxOutputTokens: 1024,
      },
    },
  },
};

const redactedToolCall = {
  schemaVersion: 1 as const,
  type: 'tool_call' as const,
  callId: 'call-1',
  toolName: 'repository.search',
  args: { redacted: true as const },
};

const modelResponded: TraceEventInput = {
  eventType: 'model.responded',
  turnIndex: 0,
  durationMs: 10,
  payload: {
    response: {
      schemaVersion: 1,
      output: redactedToolCall,
    },
  },
};

const toolRequested: TraceEventInput = {
  eventType: 'tool.requested',
  turnIndex: 0,
  payload: {
    callId: 'call-1',
    toolName: 'repository.search',
    args: { redacted: true },
  },
};

const toolCompleted: TraceEventInput = {
  eventType: 'tool.completed',
  turnIndex: 0,
  durationMs: 5,
  payload: {
    callId: 'call-1',
    toolName: 'repository.search',
    data: { matches: ['src/core/runtime.ts'] },
    truncated: false,
    durationMs: 5,
  },
};

const turnCompleted: TraceEventInput = {
  eventType: 'turn.completed',
  turnIndex: 0,
  payload: {
    turn: {
      schemaVersion: 1,
      sessionId: 'session-1',
      turnIndex: 0,
      inputMessage: 'Inspect the repository.',
      modelResponse: redactedToolCall,
      action: redactedToolCall,
      observations: [
        {
          schemaVersion: 1,
          type: 'tool_result',
          callId: 'call-1',
          toolName: 'repository.search',
          data: { matches: ['src/core/runtime.ts'] },
          truncated: false,
          durationMs: 5,
        },
      ],
    },
  },
};

const sessionCompleted: TraceEventInput = {
  eventType: 'session.completed',
  turnIndex: null,
  payload: {
    finalOutput: 'Done',
    turnCount: 1,
  },
};

function createRecorder(
  sink: TraceSink = new InMemoryTraceSink(),
  createEventId: (sequence: number) => string = (sequence) => `event-${String(sequence)}`,
): TraceRecorder {
  return new TraceRecorder({
    sessionId: 'session-1',
    sink,
    now: () => timestamp,
    createEventId,
  });
}

async function expectRecorderError(
  promise: Promise<unknown>,
  code: TraceRecorderError['code'],
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(TraceRecorderError);
  expect(thrown).toMatchObject({ code });
}

describe('TraceRecorder', () => {
  it('assigns deterministic IDs, timestamps, and continuous sequences', async () => {
    const sink = new InMemoryTraceSink();
    const recorder = createRecorder(sink);

    const started = await recorder.record(sessionStarted);
    const completed = await recorder.record(sessionCompleted);

    expect(started).toMatchObject({
      eventId: 'event-0',
      sessionId: 'session-1',
      sequence: 0,
      timestamp: timestamp.toISOString(),
    });
    expect(completed).toMatchObject({
      eventId: 'event-1',
      sequence: 1,
    });
    expect(sink.getEvents()).toEqual([started, completed]);
  });

  it('accepts paired model and tool lifecycles before a completed terminal event', async () => {
    const sink = new InMemoryTraceSink();
    const recorder = createRecorder(sink);

    for (const input of [
      sessionStarted,
      modelRequested,
      modelResponded,
      toolRequested,
      toolCompleted,
      turnCompleted,
      sessionCompleted,
    ]) {
      await recorder.record(input);
    }

    expect(sink.getEvents().map((event) => event.eventType)).toEqual([
      'session.started',
      'model.requested',
      'model.responded',
      'tool.requested',
      'tool.completed',
      'turn.completed',
      'session.completed',
    ]);
  });

  it('allows session failure to close an outstanding failed model call', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);
    await recorder.record(modelRequested);

    await expect(
      recorder.record({
        eventType: 'session.failed',
        turnIndex: null,
        payload: {
          error: { code: 'MODEL_CALL_FAILED', message: 'The model call failed' },
          turnCount: 0,
        },
      }),
    ).resolves.toMatchObject({ eventType: 'session.failed', sequence: 2 });
  });

  it('requires session.started to be the first event', async () => {
    await expectRecorderError(createRecorder().record(sessionCompleted), 'TRACE_LIFECYCLE_INVALID');
  });

  it('rejects model responses without a matching request', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);

    await expectRecorderError(recorder.record(modelResponded), 'TRACE_LIFECYCLE_INVALID');
  });

  it('preserves schema errors and allows a corrected next event', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);

    let thrown: unknown;
    try {
      const invalidInput = {
        eventType: 'context.built',
        turnIndex: 0,
        payload: { context: { schemaVersion: 1, systemRules: [] } },
      } as unknown as TraceEventInput;
      await recorder.record(invalidInput);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ObservabilityContractError);
    expect(thrown).toMatchObject({ code: 'TRACE_EVENT_INVALID' });

    await expect(recorder.record(sessionCompleted)).resolves.toMatchObject({ sequence: 1 });
  });

  it('normalizes unexpected event construction errors without leaking causes', async () => {
    const recorder = new TraceRecorder({
      sessionId: 'session-1',
      sink: new InMemoryTraceSink(),
      now: () => {
        throw new Error('private clock details');
      },
    });

    const error = await recorder.record(sessionStarted).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TraceRecorderError);
    expect(error).toMatchObject({ code: 'TRACE_LIFECYCLE_INVALID' });
    expect(String(error)).not.toContain('private clock details');
  });

  it('rejects completion while a model request remains open', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);
    await recorder.record(modelRequested);

    await expectRecorderError(recorder.record(sessionCompleted), 'TRACE_LIFECYCLE_INVALID');
  });

  it('rejects tool completion without a matching request', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);

    await expectRecorderError(recorder.record(toolCompleted), 'TRACE_LIFECYCLE_INVALID');
  });

  it('rejects duplicate open tool calls and mismatched turn pairs', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);
    await recorder.record(toolRequested);

    await expectRecorderError(recorder.record(toolRequested), 'TRACE_LIFECYCLE_INVALID');
    await expectRecorderError(
      recorder.record({ ...toolCompleted, turnIndex: 1 }),
      'TRACE_LIFECYCLE_INVALID',
    );
    await expect(recorder.record(toolCompleted)).resolves.toMatchObject({
      eventType: 'tool.completed',
    });
  });

  it('enforces mutually exclusive terminal events and rejects later events', async () => {
    const recorder = createRecorder();
    await recorder.record(sessionStarted);
    await recorder.record(sessionCompleted);

    await expectRecorderError(recorder.record(sessionCompleted), 'TRACE_LIFECYCLE_INVALID');
    await expectRecorderError(
      recorder.record({
        eventType: 'session.failed',
        turnIndex: null,
        payload: {
          error: { code: 'RUN_TIMEOUT', message: 'The runtime timed out' },
          turnCount: 0,
        },
      }),
      'TRACE_LIFECYCLE_INVALID',
    );
  });

  it('normalizes sink failures and prevents uncertain continuation', async () => {
    let writes = 0;
    const sink: TraceSink = {
      append() {
        writes += 1;
        return writes === 1 ? Promise.resolve() : Promise.reject(new Error('private path'));
      },
    };
    const recorder = createRecorder(sink);
    await recorder.record(sessionStarted);

    await expectRecorderError(recorder.record(sessionCompleted), 'TRACE_WRITE_FAILED');
    await expectRecorderError(recorder.record(sessionCompleted), 'TRACE_RECORDER_FAILED');
  });

  it('rejects concurrent appends instead of producing uncertain order', async () => {
    let release: (() => void) | undefined;
    const sink: TraceSink = {
      append() {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const recorder = createRecorder(sink);

    const first = recorder.record(sessionStarted);
    await expectRecorderError(recorder.record(sessionStarted), 'TRACE_CONCURRENT_APPEND');
    expect(release).toBeTypeOf('function');
    release?.();
    await expect(first).resolves.toMatchObject({ sequence: 0 });
  });

  it('rejects duplicate generated event IDs', async () => {
    const recorder = createRecorder(new InMemoryTraceSink(), () => 'duplicate-id');
    await recorder.record(sessionStarted);

    await expectRecorderError(recorder.record(sessionCompleted), 'TRACE_EVENT_ID_DUPLICATE');
  });
});

describe('InMemoryTraceSink', () => {
  it('returns snapshots that cannot mutate stored events', async () => {
    const sink = new InMemoryTraceSink();
    const recorder = createRecorder(sink);
    await recorder.record(sessionStarted);

    const snapshot = sink.getEvents() as TraceEvent[];
    snapshot.length = 0;

    expect(sink.getEvents()).toHaveLength(1);
  });
});
