import { describe, expect, it } from 'vitest';

import {
  ObservabilityContractError,
  parseRunManifest,
  parseTraceEvent,
  runManifestSchema,
  traceEventSchema,
  type RunManifest,
} from '../../src/observability/trace-contracts.js';

const timestamp = '2026-09-20T10:00:00.000Z';
const hash = 'a'.repeat(64);

function event(eventType: string, payload: unknown, turnIndex: number | null = 0): unknown {
  return {
    schemaVersion: 1,
    eventId: `event-${eventType.replace('.', '-')}`,
    sessionId: 'session-1',
    turnIndex,
    sequence: 0,
    eventType,
    timestamp,
    payload,
  };
}

const context = {
  schemaVersion: 1,
  systemRules: ['Return one action.'],
  taskInput: 'Inspect the repository.',
  recentTurns: [],
  observations: [],
  omittedTurnCount: 0,
  omittedObservationCount: 0,
};

const modelRequest = {
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
};

const redactedToolCall = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-1',
  toolName: 'repository.search',
  args: { redacted: true },
};

const manifest: RunManifest = {
  schemaVersion: 1,
  traceSchemaVersion: 1,
  sessionId: 'session-1',
  configId: 'baseline',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
  },
  status: 'completed',
  createdAt: timestamp,
  completedAt: '2026-09-20T10:00:01.000Z',
  configSummary: {
    schemaVersion: 1,
    runtime: {
      maxTurns: 8,
      timeoutMs: 120_000,
    },
    tools: {
      enabled: ['repository.search'],
    },
  },
  artifacts: {
    trace: {
      path: 'trace.jsonl',
      bytes: 512,
      sha256: hash,
    },
    finalOutput: {
      path: 'final-output.json',
      bytes: 32,
      sha256: hash,
    },
  },
};

describe('trace event contracts', () => {
  it.each([
    event(
      'session.started',
      {
        configId: 'baseline',
        scenarioId: 'repo-qa',
        model: { provider: 'fake', name: 'deterministic-model' },
        inputMessage: 'Inspect the repository.',
      },
      null,
    ),
    event('context.built', { context }),
    event('model.requested', { request: modelRequest }),
    event('model.responded', {
      response: {
        schemaVersion: 1,
        output: { schemaVersion: 1, type: 'final_answer', content: 'Done' },
      },
    }),
    event('tool.requested', {
      callId: 'call-1',
      toolName: 'repository.search',
      args: { redacted: true },
    }),
    event('tool.completed', {
      callId: 'call-1',
      toolName: 'repository.search',
      data: { matches: ['src/core/runtime.ts'] },
      truncated: false,
      durationMs: 12,
    }),
    event('tool.failed', {
      callId: 'call-1',
      toolName: 'repository.search',
      code: 'INPUT_INVALID',
      message: 'The tool input is invalid',
      retryable: false,
      durationMs: 1,
    }),
    event('turn.completed', {
      turn: {
        schemaVersion: 1,
        sessionId: 'session-1',
        turnIndex: 0,
        inputMessage: 'Inspect the repository.',
        modelResponse: redactedToolCall,
        action: redactedToolCall,
        observations: [],
      },
    }),
    event(
      'session.completed',
      {
        finalOutput: { summary: 'Done' },
        turnCount: 1,
      },
      null,
    ),
    event(
      'session.failed',
      {
        error: {
          code: 'MODEL_CALL_FAILED',
          message: 'The model call failed',
          cause: { name: 'ModelAdapterError', code: 'MODEL_CALL_FAILED' },
        },
        turnCount: 0,
      },
      null,
    ),
  ])('accepts and round-trips event type $eventType', (value) => {
    const parsed = traceEventSchema.parse(value);

    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it.each([
    ['unknown event type', event('eval.case.scored', {})],
    [
      'unknown envelope field',
      {
        ...(event('session.completed', { finalOutput: 'Done', turnCount: 1 }) as object),
        extra: true,
      },
    ],
    [
      'unsupported schema version',
      {
        ...(event('session.completed', { finalOutput: 'Done', turnCount: 1 }) as object),
        schemaVersion: 2,
      },
    ],
    [
      'invalid sequence',
      {
        ...(event('session.completed', { finalOutput: 'Done', turnCount: 1 }) as object),
        sequence: -1,
      },
    ],
    [
      'absolute artifact reference',
      {
        ...(event('session.completed', { finalOutput: 'Done', turnCount: 1 }) as object),
        artifactRefs: ['C:/private/trace.jsonl'],
      },
    ],
    [
      'unredacted tool arguments',
      event('tool.requested', {
        callId: 'call-1',
        toolName: 'repository.search',
        args: { query: 'secret input' },
      }),
    ],
    [
      'unredacted model tool response',
      event('model.responded', {
        response: {
          schemaVersion: 1,
          output: { ...redactedToolCall, args: { query: 'secret input' } },
        },
      }),
    ],
    [
      'unredacted completed turn',
      event('turn.completed', {
        turn: {
          schemaVersion: 1,
          sessionId: 'session-1',
          turnIndex: 0,
          inputMessage: 'Inspect the repository.',
          action: { ...redactedToolCall, args: { query: 'secret input' } },
          observations: [],
        },
      }),
    ],
    [
      'nested sensitive field',
      event('session.completed', {
        finalOutput: { nested: { api_key: 'must-not-persist' } },
        turnCount: 1,
      }),
    ],
    [
      'sensitive field nested inside an array',
      event('session.completed', {
        finalOutput: [{ nested: { apiKey: 'must-not-persist' } }],
        turnCount: 1,
      }),
    ],
    [
      'unredacted model response in a completed turn',
      event('turn.completed', {
        turn: {
          schemaVersion: 1,
          sessionId: 'session-1',
          turnIndex: 0,
          inputMessage: 'Inspect the repository.',
          modelResponse: { ...redactedToolCall, args: { query: 'secret input' } },
          action: { schemaVersion: 1, type: 'final_answer', content: 'Done' },
          observations: [],
        },
      }),
    ],
    [
      'undefined payload value',
      event('session.completed', { finalOutput: { value: undefined }, turnCount: 1 }),
    ],
    [
      'BigInt payload value',
      event('session.completed', { finalOutput: { value: 1n }, turnCount: 1 }),
    ],
    [
      'function payload value',
      event('session.completed', { finalOutput: { value: () => undefined }, turnCount: 1 }),
    ],
    [
      'non-finite payload value',
      event('session.completed', { finalOutput: Number.POSITIVE_INFINITY, turnCount: 1 }),
    ],
  ])('rejects %s', (_name, value) => {
    expect(traceEventSchema.safeParse(value).success).toBe(false);
  });

  it('rejects cyclic payloads', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      traceEventSchema.safeParse(event('session.completed', { finalOutput: cyclic, turnCount: 1 }))
        .success,
    ).toBe(false);
  });

  it('returns a stable trace error without exposing rejected input', () => {
    const sensitiveValue = 'must-not-appear';
    let thrown: unknown;

    try {
      parseTraceEvent(
        event('session.completed', {
          finalOutput: { password: sensitiveValue },
          turnCount: 1,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ObservabilityContractError);
    expect(thrown).toMatchObject({
      name: 'ObservabilityContractError',
      code: 'TRACE_EVENT_INVALID',
      message: 'The trace event is invalid',
    });
    expect(String(thrown)).not.toContain(sensitiveValue);
  });
});

describe('run manifest contract', () => {
  it('accepts and round-trips a terminal run manifest', () => {
    expect(parseRunManifest(JSON.parse(JSON.stringify(manifest)) as unknown)).toEqual(manifest);
  });

  it.each([
    ['unknown field', { ...manifest, apiKey: 'must-not-persist' }],
    ['unsupported manifest version', { ...manifest, schemaVersion: 2 }],
    ['unsupported trace version', { ...manifest, traceSchemaVersion: 2 }],
    ['non-terminal status', { ...manifest, status: 'running' }],
    [
      'invalid hash',
      {
        ...manifest,
        artifacts: { ...manifest.artifacts, trace: { ...manifest.artifacts.trace, sha256: 'bad' } },
      },
    ],
    [
      'absolute path',
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          trace: { ...manifest.artifacts.trace, path: 'C:/private/trace.jsonl' },
        },
      },
    ],
    [
      'parent path',
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          trace: { ...manifest.artifacts.trace, path: '../trace.jsonl' },
        },
      },
    ],
    ['completion before creation', { ...manifest, completedAt: '2026-09-20T09:59:59.000Z' }],
    [
      'sensitive nested field',
      {
        ...manifest,
        configSummary: {
          ...manifest.configSummary,
          tools: { enabled: [], credentials: 'must-not-persist' },
        },
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(runManifestSchema.safeParse(value).success).toBe(false);
  });

  it('returns a stable manifest error without exposing paths', () => {
    const privatePath = 'C:/Users/private/trace.jsonl';
    let thrown: unknown;

    try {
      parseRunManifest({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          trace: { ...manifest.artifacts.trace, path: privatePath },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ObservabilityContractError);
    expect(thrown).toMatchObject({
      code: 'RUN_MANIFEST_INVALID',
      message: 'The run manifest is invalid',
    });
    expect(String(thrown)).not.toContain(privatePath);
  });
});
