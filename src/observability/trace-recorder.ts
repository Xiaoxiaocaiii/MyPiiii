import { ObservabilityContractError, parseTraceEvent, type TraceEvent } from './trace-contracts.js';

export interface TraceSink {
  append(event: TraceEvent): Promise<void>;
}

export type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'sessionId' | 'sequence' | 'timestamp'>
    : never
  : never;

export interface TraceRecorderOptions {
  readonly sessionId: string;
  readonly sink: TraceSink;
  readonly now?: () => Date;
  readonly createEventId?: (sequence: number) => string;
}

export type TraceRecorderErrorCode =
  | 'TRACE_CONCURRENT_APPEND'
  | 'TRACE_EVENT_ID_DUPLICATE'
  | 'TRACE_LIFECYCLE_INVALID'
  | 'TRACE_RECORDER_FAILED'
  | 'TRACE_WRITE_FAILED';

const recorderErrorMessages: Record<TraceRecorderErrorCode, string> = {
  TRACE_CONCURRENT_APPEND: 'A trace append is already in progress',
  TRACE_EVENT_ID_DUPLICATE: 'The trace event identifier is duplicated',
  TRACE_LIFECYCLE_INVALID: 'The trace event violates the lifecycle',
  TRACE_RECORDER_FAILED: 'The trace recorder cannot continue after a write failure',
  TRACE_WRITE_FAILED: 'The trace event could not be persisted',
};

export class TraceRecorderError extends Error {
  override readonly name = 'TraceRecorderError';
  readonly code: TraceRecorderErrorCode;

  constructor(code: TraceRecorderErrorCode) {
    super(recorderErrorMessages[code]);
    this.code = code;
  }
}

interface LifecycleState {
  readonly started: boolean;
  readonly terminal: TraceEvent['eventType'] | null;
  readonly openModelTurn: number | null;
  readonly openTools: ReadonlyMap<string, number>;
}

const initialLifecycleState: LifecycleState = {
  started: false,
  terminal: null,
  openModelTurn: null,
  openTools: new Map(),
};

export class TraceRecorder {
  readonly #sessionId: string;
  readonly #sink: TraceSink;
  readonly #now: () => Date;
  readonly #createEventId: (sequence: number) => string;
  readonly #eventIds = new Set<string>();
  #sequence = 0;
  #state = initialLifecycleState;
  #appendInProgress = false;
  #writeFailed = false;

  constructor(options: TraceRecorderOptions) {
    this.#sessionId = options.sessionId;
    this.#sink = options.sink;
    this.#now = options.now ?? (() => new Date());
    this.#createEventId =
      options.createEventId ?? ((sequence) => `${this.#sessionId}.event.${String(sequence)}`);
  }

  async record(input: TraceEventInput): Promise<TraceEvent> {
    if (this.#writeFailed) {
      throw new TraceRecorderError('TRACE_RECORDER_FAILED');
    }
    if (this.#appendInProgress) {
      throw new TraceRecorderError('TRACE_CONCURRENT_APPEND');
    }

    this.#appendInProgress = true;
    try {
      const eventId = this.#createEventId(this.#sequence);
      if (this.#eventIds.has(eventId)) {
        throw new TraceRecorderError('TRACE_EVENT_ID_DUPLICATE');
      }

      const event = this.#createEvent(input, eventId);
      const nextState = transition(this.#state, event);

      try {
        await this.#sink.append(event);
      } catch {
        this.#writeFailed = true;
        throw new TraceRecorderError('TRACE_WRITE_FAILED');
      }

      this.#eventIds.add(eventId);
      this.#sequence += 1;
      this.#state = nextState;
      return event;
    } finally {
      this.#appendInProgress = false;
    }
  }

  #createEvent(input: TraceEventInput, eventId: string): TraceEvent {
    try {
      return parseTraceEvent({
        schemaVersion: 1,
        eventId,
        sessionId: this.#sessionId,
        sequence: this.#sequence,
        timestamp: this.#now().toISOString(),
        ...input,
      });
    } catch (error) {
      if (error instanceof ObservabilityContractError) {
        throw error;
      }
      throw new TraceRecorderError('TRACE_LIFECYCLE_INVALID');
    }
  }
}

export class InMemoryTraceSink implements TraceSink {
  readonly #events: TraceEvent[] = [];

  append(event: TraceEvent): Promise<void> {
    this.#events.push(structuredClone(parseTraceEvent(event)));
    return Promise.resolve();
  }

  getEvents(): readonly TraceEvent[] {
    return structuredClone(this.#events);
  }
}

function transition(state: LifecycleState, event: TraceEvent): LifecycleState {
  if (state.terminal !== null) {
    throw new TraceRecorderError('TRACE_LIFECYCLE_INVALID');
  }

  if (event.eventType === 'session.started') {
    requireLifecycle(!state.started && event.turnIndex === null);
    return { ...state, started: true };
  }

  requireLifecycle(state.started);
  requireTurnIndex(event);

  const openTools = new Map(state.openTools);
  const next: LifecycleState = {
    ...state,
    openTools,
  };

  switch (event.eventType) {
    case 'context.built':
      return next;
    case 'model.requested':
      requireLifecycle(state.openModelTurn === null);
      requireLifecycle(event.payload.request.sessionId === event.sessionId);
      requireLifecycle(event.payload.request.turnIndex === event.turnIndex);
      return { ...next, openModelTurn: event.turnIndex };
    case 'model.responded':
      requireLifecycle(state.openModelTurn === event.turnIndex);
      return { ...next, openModelTurn: null };
    case 'tool.requested': {
      requireLifecycle(!state.openTools.has(event.payload.callId));
      const turnIndex = event.turnIndex;
      requireLifecycle(turnIndex !== null);
      openTools.set(event.payload.callId, turnIndex);
      return next;
    }
    case 'tool.completed':
    case 'tool.failed':
      requireLifecycle(state.openTools.get(event.payload.callId) === event.turnIndex);
      openTools.delete(event.payload.callId);
      return next;
    case 'turn.completed':
      requireLifecycle(event.payload.turn.sessionId === event.sessionId);
      requireLifecycle(event.payload.turn.turnIndex === event.turnIndex);
      requireLifecycle(state.openModelTurn !== event.turnIndex);
      requireLifecycle(![...state.openTools.values()].includes(event.turnIndex));
      return next;
    case 'session.completed':
      requireLifecycle(state.openModelTurn === null && state.openTools.size === 0);
      return { ...next, terminal: event.eventType };
    case 'session.failed':
      requireLifecycle(state.openTools.size === 0);
      return { ...next, openModelTurn: null, terminal: event.eventType };
  }
}

function requireTurnIndex(event: Exclude<TraceEvent, { eventType: 'session.started' }>): void {
  const isSessionTerminal =
    event.eventType === 'session.completed' || event.eventType === 'session.failed';
  requireLifecycle(isSessionTerminal ? event.turnIndex === null : event.turnIndex !== null);
}

function requireLifecycle(condition: boolean): asserts condition {
  if (!condition) {
    throw new TraceRecorderError('TRACE_LIFECYCLE_INVALID');
  }
}
