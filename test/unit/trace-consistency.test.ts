import { describe, expect, it } from 'vitest';

import { type JsonValue } from '../../src/core/contracts.js';
import {
  parseRunManifest,
  traceEventSchema,
  type TraceEvent,
} from '../../src/observability/trace-contracts.js';
import {
  analyzeTraceConsistency,
  attributeTraceFailure,
} from '../../src/observability/trace-consistency.js';
import type { LoadedTraceRun } from '../../src/observability/trace-loader.js';

const timestamp = '2026-09-25T10:00:00.000Z';

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
    completedAt: '2026-09-25T10:00:01.000Z',
    configSummary: {
      schemaVersion: 1,
      runtime: { maxTurns: 3, timeoutMs: 1000 },
      context: { maxCharacters: 4000, recentTurns: 4, observationMaxCharacters: 2000 },
      tools: { enabled: [] },
    },
    artifacts: {
      trace: { path: 'trace.jsonl', bytes: 1, sha256: 'a'.repeat(64) },
      finalOutput: { path: 'final-output.json', bytes: 1, sha256: 'b'.repeat(64) },
    },
  });
}

function event(value: unknown): TraceEvent {
  return traceEventSchema.parse(value);
}

function run(
  events: TraceEvent[],
  finalOutput: JsonValue = 'Done',
  status: 'completed' | 'failed' = 'completed',
): LoadedTraceRun {
  return { manifest: manifest(status), events, finalOutput };
}

function completedEvents(): TraceEvent[] {
  return [
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
      turnIndex: null,
      sequence: 1,
      eventType: 'session.completed',
      timestamp,
      payload: { finalOutput: 'Done', turnCount: 0 },
    }),
  ];
}

describe('trace consistency and attribution', () => {
  it('accepts matching terminal output and storage status', () => {
    const report = analyzeTraceConsistency(run(completedEvents()), {
      sqliteStatus: 'completed',
    });

    expect(report).toMatchObject({ schemaVersion: 1, consistent: true, issues: [] });
  });

  it('reports the first terminal output mismatch with public event evidence', () => {
    const report = analyzeTraceConsistency(run(completedEvents(), 'Changed'), {
      sqliteStatus: 'completed',
    });

    expect(report).toMatchObject({
      consistent: false,
      issues: [
        {
          code: 'CONSISTENCY_FINAL_OUTPUT_MISMATCH',
          category: 'storage',
          sequence: 1,
          eventId: 'event-1',
          turnIndex: null,
        },
      ],
    });
  });

  it('reports Manifest and SQLite status contradictions', () => {
    const report = analyzeTraceConsistency(run(completedEvents()), { sqliteStatus: 'failed' });
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'CONSISTENCY_SQLITE_STATUS_MISMATCH',
    ]);

    const failedManifest = analyzeTraceConsistency(run(completedEvents(), 'Done', 'failed'), {
      sqliteStatus: 'failed',
    });
    expect(failedManifest.issues[0]?.code).toBe('CONSISTENCY_MANIFEST_STATUS_MISMATCH');
  });

  it('maps stable failure codes to deterministic attribution categories', () => {
    expect(attributeTraceFailure({ code: 'MODEL_CALL_FAILED' }).category).toBe('model');
    expect(attributeTraceFailure({ code: 'TOOL_TIMEOUT' }).category).toBe('tool');
    expect(attributeTraceFailure({ code: 'CONTEXT_BUDGET_EXCEEDED' }).category).toBe('context');
    expect(attributeTraceFailure({ code: 'RUNTIME_CANCELLED' }).category).toBe('runtime');
    expect(attributeTraceFailure({ code: 'RUN_INDEX_QUERY_FAILED' }).category).toBe('storage');
    expect(attributeTraceFailure({ code: 'TRACE_HASH_MISMATCH' }).category).toBe('trace_integrity');
    expect(attributeTraceFailure({ code: 'SOMETHING_ELSE' }).category).toBe('unknown');
  });

  it('reports a missing terminal event as a runtime issue', () => {
    const report = analyzeTraceConsistency(run([completedEvents()[0]!], 'Done'));

    expect(report.issues[0]).toMatchObject({
      code: 'CONSISTENCY_TERMINAL_MISSING',
      category: 'runtime',
      sequence: null,
      eventId: null,
      turnIndex: null,
    });
  });

  it('reports duplicate terminal events at the second terminal evidence', () => {
    const secondTerminal = event({
      schemaVersion: 1,
      eventId: 'event-2',
      sessionId: 'session-1',
      turnIndex: null,
      sequence: 2,
      eventType: 'session.failed',
      timestamp,
      payload: {
        error: { code: 'MODEL_CALL_FAILED', message: 'The model call failed' },
        turnCount: 0,
      },
    });

    const report = analyzeTraceConsistency(run([...completedEvents(), secondTerminal]));
    expect(report.issues).toContainEqual({
      code: 'CONSISTENCY_TERMINAL_DUPLICATE',
      category: 'trace_integrity',
      sequence: 2,
      eventId: 'event-2',
      turnIndex: null,
      message: 'More than one terminal event was observed',
    });
  });

  it('reports replay turn gaps and omits an unavailable replay result', () => {
    const response = event({
      schemaVersion: 1,
      eventId: 'event-response',
      sessionId: 'session-1',
      turnIndex: 0,
      sequence: 1,
      eventType: 'model.responded',
      timestamp,
      payload: { response: { schemaVersion: 1, output: 'Done' } },
    });

    const report = analyzeTraceConsistency(
      run([completedEvents()[0]!, response, completedEvents()[1]!]),
    );
    expect(report).toMatchObject({
      consistent: false,
      issues: [
        {
          code: 'REPLAY_TURN_MISSING',
          category: 'runtime',
          sequence: null,
          eventId: null,
          turnIndex: null,
        },
      ],
    });
    expect(report).not.toHaveProperty('replay');
  });

  it('classifies unexpected replay exceptions without exposing their details', () => {
    const malformedResponse = {
      ...completedEvents()[0]!,
      eventId: 'event-malformed',
      sequence: 1,
      turnIndex: 0,
      eventType: 'model.responded',
      payload: undefined,
    } as unknown as TraceEvent;

    const report = analyzeTraceConsistency(
      run([completedEvents()[0]!, malformedResponse, completedEvents()[1]!]),
    );
    expect(report.issues).toContainEqual({
      code: 'REPLAY_UNKNOWN_FAILURE',
      category: 'unknown',
      sequence: null,
      eventId: null,
      turnIndex: null,
      message: 'The persisted run could not be trusted',
    });
    expect(JSON.stringify(report)).not.toContain('TypeError');
  });
});
