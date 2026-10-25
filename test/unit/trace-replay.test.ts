import { describe, expect, it } from 'vitest';

import { replayLoadedTrace } from '../../src/observability/trace-replay.js';
import {
  parseRunManifest,
  traceEventSchema,
  type TraceEvent,
} from '../../src/observability/trace-contracts.js';
import type { LoadedTraceRun } from '../../src/observability/trace-loader.js';

const timestamp = '2026-09-21T10:00:00.000Z';

function event(value: unknown): TraceEvent {
  return traceEventSchema.parse(value);
}

function manifest(status: 'completed' | 'failed' = 'completed') {
  return parseRunManifest({
    schemaVersion: 1,
    traceSchemaVersion: 1,
    sessionId: 'session-1',
    configId: 'baseline',
    scenarioId: 'repo-qa',
    model: { provider: 'fake', name: 'deterministic-model' },
    status,
    createdAt: timestamp,
    completedAt: '2026-09-21T10:00:01.000Z',
    configSummary: {
      schemaVersion: 1,
      runtime: {
        maxTurns: 3,
        timeoutMs: 1000,
      },
      context: {
        maxCharacters: 4000,
        recentTurns: 4,
        observationMaxCharacters: 2000,
      },
      tools: {
        enabled: [],
      },
    },
    artifacts: {
      trace: { path: 'trace.jsonl', bytes: 1, sha256: 'a'.repeat(64) },
      finalOutput: { path: 'final-output.json', bytes: 1, sha256: 'b'.repeat(64) },
    },
  });
}

function loaded(
  events: TraceEvent[],
  status: 'completed' | 'failed' = 'completed',
): LoadedTraceRun {
  return { manifest: manifest(status), events, finalOutput: 'Done' };
}

function completedRun(): LoadedTraceRun {
  return loaded([
    event({
      schemaVersion: 1,
      eventId: 'event-0',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 0,
      eventType: 'session.started',
      timestamp,
      payload: {
        configId: 'baseline',
        scenarioId: 'repo-qa',
        model: { provider: 'fake', name: 'deterministic-model' },
        inputMessage: 'Inspect the repository.',
      },
    }),
    event({
      schemaVersion: 1,
      eventId: 'event-1',
      sessionId: 'session-1',
      turnIndex: 0,
      sequence: 1,
      eventType: 'model.requested',
      timestamp,
      payload: {
        request: {
          schemaVersion: 1,
          sessionId: 'session-1',
          turnIndex: 0,
          inputMessage: 'Inspect the repository.',
          model: { provider: 'fake', name: 'deterministic-model' },
        },
      },
    }),
    event({
      schemaVersion: 1,
      eventId: 'event-2',
      sessionId: 'session-1',
      turnIndex: 0,
      sequence: 2,
      eventType: 'model.responded',
      timestamp,
      payload: { response: { schemaVersion: 1, output: 'Done' } },
    }),
    event({
      schemaVersion: 1,
      eventId: 'event-3',
      sessionId: 'session-1',
      turnIndex: 0,
      sequence: 3,
      eventType: 'turn.completed',
      timestamp,
      payload: {
        turn: {
          schemaVersion: 1,
          sessionId: 'session-1',
          turnIndex: 0,
          inputMessage: 'Inspect the repository.',
          action: { schemaVersion: 1, type: 'final_answer', content: 'Done' },
          observations: [],
        },
      },
    }),
    event({
      schemaVersion: 1,
      eventId: 'event-4',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 4,
      eventType: 'session.completed',
      timestamp,
      payload: { finalOutput: 'Done', turnCount: 1 },
    }),
  ]);
}

describe('replayLoadedTrace', () => {
  it('reconstructs a completed turn without invoking a model or tool', () => {
    const first = replayLoadedTrace(completedRun());
    const second = replayLoadedTrace(completedRun());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-1',
      status: 'completed',
      finalOutput: 'Done',
      turns: [
        {
          turnIndex: 0,
          inputMessage: 'Inspect the repository.',
          modelOutput: 'Done',
          action: { type: 'final_answer', content: 'Done' },
          observations: [],
        },
      ],
    });
    expect(first.eventEvidence.map((item) => item.eventId)).toEqual([
      'event-0',
      'event-1',
      'event-2',
      'event-3',
      'event-4',
    ]);
  });

  it('reconstructs tool results and errors from persisted events', () => {
    const run = completedRun();
    const toolEvents = [
      event({
        schemaVersion: 1,
        eventId: 'event-5',
        sessionId: 'session-1',
        turnIndex: 0,
        sequence: 5,
        eventType: 'tool.completed',
        timestamp,
        payload: {
          callId: 'call-1',
          toolName: 'read',
          data: { value: 1 },
          truncated: false,
          durationMs: 2,
        },
      }),
      event({
        schemaVersion: 1,
        eventId: 'event-6',
        sessionId: 'session-1',
        turnIndex: 0,
        sequence: 6,
        eventType: 'turn.completed',
        timestamp,
        payload: {
          turn: {
            schemaVersion: 1,
            sessionId: 'session-1',
            turnIndex: 0,
            inputMessage: 'Inspect the repository.',
            observations: [],
          },
        },
      }),
      event({
        schemaVersion: 1,
        eventId: 'event-7',
        sessionId: 'session-1',
        turnIndex: null,
        sequence: 7,
        eventType: 'session.completed',
        timestamp,
        payload: { finalOutput: 'Done', turnCount: 1 },
      }),
    ];
    const result = replayLoadedTrace(loaded([...run.events.slice(0, 3), ...toolEvents]));

    expect(result.turns[0]?.observations).toEqual([
      expect.objectContaining({ type: 'tool_result', callId: 'call-1' }),
    ]);
  });

  it('deduplicates matching tool observations recorded in both tool and turn events', () => {
    const observation = {
      type: 'tool_result',
      schemaVersion: 1,
      callId: 'call-1',
      toolName: 'read',
      data: { value: 1 },
      truncated: false,
      durationMs: 2,
    } as const;
    const events = [
      ...completedRun().events.slice(0, 3),
      event({
        schemaVersion: 1,
        eventId: 'event-tool-completed',
        sessionId: 'session-1',
        turnIndex: 0,
        sequence: 3,
        eventType: 'tool.completed',
        timestamp,
        payload: {
          callId: observation.callId,
          toolName: observation.toolName,
          data: observation.data,
          truncated: observation.truncated,
          durationMs: observation.durationMs,
        },
      }),
      event({
        schemaVersion: 1,
        eventId: 'event-turn-completed',
        sessionId: 'session-1',
        turnIndex: 0,
        sequence: 4,
        eventType: 'turn.completed',
        timestamp,
        payload: {
          turn: {
            schemaVersion: 1,
            sessionId: 'session-1',
            turnIndex: 0,
            inputMessage: 'Inspect the repository.',
            action: { schemaVersion: 1, type: 'final_answer', content: 'Done' },
            observations: [observation],
          },
        },
      }),
      event({
        schemaVersion: 1,
        eventId: 'event-session-completed',
        sessionId: 'session-1',
        turnIndex: null,
        sequence: 5,
        eventType: 'session.completed',
        timestamp,
        payload: { finalOutput: 'Done', turnCount: 1 },
      }),
    ];

    const result = replayLoadedTrace(loaded(events));

    expect(result.turns[0]?.observations).toEqual([observation]);
  });

  it('reconstructs failed tool observations before the turn completes', () => {
    const run = completedRun();
    const failedTool = event({
      schemaVersion: 1,
      eventId: 'event-tool-failed',
      sessionId: 'session-1',
      turnIndex: 0,
      sequence: 3,
      eventType: 'tool.failed',
      timestamp,
      payload: {
        callId: 'call-2',
        toolName: 'read',
        code: 'TOOL_TIMEOUT',
        message: 'The tool timed out',
        retryable: true,
        durationMs: 100,
      },
    });
    const events = [...run.events.slice(0, 3), failedTool, ...run.events.slice(3)].map(
      (traceEvent, sequence) => event({ ...traceEvent, sequence }),
    );

    const result = replayLoadedTrace(loaded(events));
    expect(result.turns[0]?.observations).toEqual([
      expect.objectContaining({
        type: 'tool_error',
        callId: 'call-2',
        code: 'TOOL_TIMEOUT',
      }),
    ]);
  });

  it('reconstructs model failure and does not synthesize a final output', () => {
    const result = replayLoadedTrace(
      loaded(
        [
          completedRun().events[0]!,
          event({
            schemaVersion: 1,
            eventId: 'event-1',
            sessionId: 'session-1',
            turnIndex: null,
            sequence: 1,
            eventType: 'session.failed',
            timestamp,
            payload: {
              error: {
                code: 'MODEL_CALL_FAILED',
                message: 'The model call failed',
              },
              turnCount: 0,
            },
          }),
        ],
        'failed',
      ),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: { code: 'MODEL_CALL_FAILED' },
    });
    expect(result).not.toHaveProperty('finalOutput');
  });

  it('rejects a replay when execution evidence has no completed turn', () => {
    const run = completedRun();
    const incomplete = loaded(run.events.slice(0, 3));

    let thrown: unknown;
    try {
      replayLoadedTrace(incomplete);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'REPLAY_TURN_MISSING' });
  });

  it.each([
    [
      'duplicate model output',
      (run: LoadedTraceRun) => {
        const duplicate = event({
          ...run.events[2],
          eventId: 'duplicate-model-output',
          sequence: 5,
        });
        return [...run.events.slice(0, 3), duplicate, ...run.events.slice(3)];
      },
    ],
    [
      'duplicate completed turn',
      (run: LoadedTraceRun) => {
        const duplicate = event({
          ...run.events[3],
          eventId: 'duplicate-completed-turn',
          sequence: 5,
        });
        return [...run.events, duplicate];
      },
    ],
    [
      'response with no turn index',
      (run: LoadedTraceRun) => {
        const response = event({ ...run.events[2], turnIndex: null });
        return [...run.events.slice(0, 2), response, ...run.events.slice(3)];
      },
    ],
  ])('rejects %s as a replay turn conflict', (_name, createEvents) => {
    let thrown: unknown;
    try {
      replayLoadedTrace(loaded(createEvents(completedRun())));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'REPLAY_TURN_CONFLICT' });
  });
});
