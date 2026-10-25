import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

import {
  agentActionSchema,
  observationSchema,
  sessionSchema,
  type JsonValue,
  type Observation,
} from '../core/contracts.js';
import { loadTraceRun, type LoadTraceRunOptions, type LoadedTraceRun } from './trace-loader.js';
import { persistedJsonValueSchema } from './trace-contracts.js';

const replayTurnSchema = z.strictObject({
  turnIndex: z.number().int().nonnegative(),
  inputMessage: z.string().min(1),
  modelOutput: persistedJsonValueSchema.optional(),
  action: agentActionSchema.optional(),
  observations: z.array(observationSchema),
});

const replayEventEvidenceSchema = z.strictObject({
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
});

export const replayResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionSchema.shape.sessionId,
  status: z.enum(['completed', 'failed']),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  turns: z.array(replayTurnSchema),
  finalOutput: persistedJsonValueSchema.optional(),
  failure: z
    .strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
      cause: z
        .strictObject({
          name: z.string().min(1),
          code: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  eventEvidence: z.array(replayEventEvidenceSchema),
});

export type ReplayResult = z.infer<typeof replayResultSchema>;
export type ReplayTurn = z.infer<typeof replayTurnSchema>;

export type TraceReplayErrorCode =
  'REPLAY_RESULT_INVALID' | 'REPLAY_TURN_CONFLICT' | 'REPLAY_TURN_MISSING';

const errorMessages: Record<TraceReplayErrorCode, string> = {
  REPLAY_RESULT_INVALID: 'The replay result is invalid',
  REPLAY_TURN_CONFLICT: 'Trace events conflict while rebuilding a turn',
  REPLAY_TURN_MISSING: 'A required completed turn event is missing',
};

export class TraceReplayError extends Error {
  override readonly name = 'TraceReplayError';
  readonly code: TraceReplayErrorCode;

  constructor(code: TraceReplayErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export async function replayTraceRun(options: LoadTraceRunOptions): Promise<ReplayResult> {
  return replayLoadedTrace(await loadTraceRun(options));
}

export function replayLoadedTrace(run: LoadedTraceRun): ReplayResult {
  const turns = new Map<number, ReplayTurn>();
  const modelOutputs = new Map<number, JsonValue>();
  const observations = new Map<number, Observation[]>();
  const requiredTurnIndices = new Set<number>();
  const evidence = run.events.map((event) => ({
    eventId: event.eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
  }));
  let finalOutput: unknown;
  let failure: ReplayResult['failure'];

  for (const event of run.events) {
    switch (event.eventType) {
      case 'model.responded':
        requiredTurnIndices.add(requireTurnIndex(event.turnIndex));
        setOnce(modelOutputs, requireTurnIndex(event.turnIndex), event.payload.response.output);
        break;
      case 'tool.completed':
        requiredTurnIndices.add(requireTurnIndex(event.turnIndex));
        addObservation(observations, requireTurnIndex(event.turnIndex), {
          type: 'tool_result',
          schemaVersion: 1,
          callId: event.payload.callId,
          toolName: event.payload.toolName,
          data: event.payload.data,
          truncated: event.payload.truncated,
          durationMs: event.payload.durationMs,
        });
        break;
      case 'tool.failed':
        requiredTurnIndices.add(requireTurnIndex(event.turnIndex));
        addObservation(observations, requireTurnIndex(event.turnIndex), {
          type: 'tool_error',
          schemaVersion: 1,
          callId: event.payload.callId,
          toolName: event.payload.toolName,
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retryable,
          durationMs: event.payload.durationMs,
        });
        break;
      case 'turn.completed': {
        const turn = event.payload.turn;
        const turnIndex = requireTurnIndex(event.turnIndex);
        const replayTurn: ReplayTurn = {
          turnIndex: turn.turnIndex,
          inputMessage: turn.inputMessage,
          modelOutput: modelOutputs.get(turnIndex),
          action: turn.action,
          observations: mergeObservations(observations.get(turnIndex) ?? [], turn.observations),
        };
        setOnce(turns, turn.turnIndex, replayTurn);
        break;
      }
      case 'session.completed':
        finalOutput = event.payload.finalOutput;
        break;
      case 'session.failed':
        failure = event.payload.error;
        break;
      default:
        break;
    }
  }

  for (const turnIndex of requiredTurnIndices) {
    if (!turns.has(turnIndex)) {
      throw new TraceReplayError('REPLAY_TURN_MISSING');
    }
  }

  const result = {
    schemaVersion: 1 as const,
    sessionId: run.manifest.sessionId,
    status: run.manifest.status,
    createdAt: run.manifest.createdAt,
    completedAt: run.manifest.completedAt,
    turns: [...turns.values()].sort((left, right) => left.turnIndex - right.turnIndex),
    ...(finalOutput === undefined ? {} : { finalOutput }),
    ...(failure === undefined ? {} : { failure }),
    eventEvidence: evidence,
  };
  const parsed = replayResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new TraceReplayError('REPLAY_RESULT_INVALID');
  }
  return parsed.data;
}

function setOnce<Value>(values: Map<number, Value>, key: number, value: Value): void {
  if (values.has(key)) {
    throw new TraceReplayError('REPLAY_TURN_CONFLICT');
  }
  values.set(key, value);
}

function addObservation(
  values: Map<number, Observation[]>,
  key: number,
  observation: Observation,
): void {
  const existing = values.get(key) ?? [];
  existing.push(observation);
  values.set(key, existing);
}

function mergeObservations(
  eventObservations: readonly Observation[],
  turnObservations: readonly Observation[],
): Observation[] {
  const merged = [...eventObservations];
  for (const observation of turnObservations) {
    const existing = merged.find((candidate) => candidate.callId === observation.callId);
    if (existing === undefined) {
      merged.push(observation);
    } else if (!isDeepStrictEqual(existing, observation)) {
      throw new TraceReplayError('REPLAY_TURN_CONFLICT');
    }
  }
  return merged;
}

function requireTurnIndex(value: number | null): number {
  if (value === null) {
    throw new TraceReplayError('REPLAY_TURN_CONFLICT');
  }
  return value;
}
