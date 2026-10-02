import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  artifactRelativePathSchema,
  parseRunManifest,
  parseTraceEvent,
  persistedJsonValueSchema,
  type RunManifest,
  type TraceEvent,
} from './trace-contracts.js';
import type { JsonValue } from '../core/contracts.js';

export type TraceIntegrityErrorCode =
  | 'TRACE_ARTIFACT_MISSING'
  | 'TRACE_EVENT_ID_DUPLICATE'
  | 'TRACE_EVENT_INVALID'
  | 'TRACE_HASH_MISMATCH'
  | 'TRACE_JSONL_TRUNCATED'
  | 'TRACE_MANIFEST_INVALID'
  | 'TRACE_PAIRING_INVALID'
  | 'TRACE_PATH_INVALID'
  | 'TRACE_SEQUENCE_INVALID'
  | 'TRACE_SESSION_MISMATCH'
  | 'TRACE_TERMINAL_INVALID';

const errorMessages: Record<TraceIntegrityErrorCode, string> = {
  TRACE_ARTIFACT_MISSING: 'A referenced trace artifact is missing',
  TRACE_EVENT_ID_DUPLICATE: 'A trace event identifier is duplicated',
  TRACE_EVENT_INVALID: 'A trace event is invalid',
  TRACE_HASH_MISMATCH: 'A trace artifact hash does not match its manifest',
  TRACE_JSONL_TRUNCATED: 'The trace JSONL content is truncated',
  TRACE_MANIFEST_INVALID: 'The run manifest is invalid',
  TRACE_PAIRING_INVALID: 'Trace lifecycle pairing is invalid',
  TRACE_PATH_INVALID: 'A manifest artifact path is invalid',
  TRACE_SEQUENCE_INVALID: 'The trace event sequence is invalid',
  TRACE_SESSION_MISMATCH: 'A trace event belongs to another session',
  TRACE_TERMINAL_INVALID: 'The trace terminal state is invalid',
};

export class TraceIntegrityError extends Error {
  override readonly name = 'TraceIntegrityError';
  readonly code: TraceIntegrityErrorCode;
  readonly line: number | null;
  readonly path: string | null;

  constructor(code: TraceIntegrityErrorCode, options: { line?: number; path?: string } = {}) {
    super(errorMessages[code]);
    this.code = code;
    this.line = options.line ?? null;
    this.path = options.path ?? null;
  }
}

export interface LoadTraceRunOptions {
  readonly sessionDirectory: string;
}

export interface LoadedTraceRun {
  readonly manifest: RunManifest;
  readonly events: readonly TraceEvent[];
  readonly finalOutput: JsonValue;
}

interface TraceState {
  started: boolean;
  terminal: boolean;
  modelTurn: number | null;
  tools: Map<string, number>;
}

export async function loadTraceRun(options: LoadTraceRunOptions): Promise<LoadedTraceRun> {
  const sessionDirectory = resolve(options.sessionDirectory);
  const manifest = await loadManifest(sessionDirectory);
  const tracePath = resolveArtifactPath(sessionDirectory, manifest.artifacts.trace.path);
  const outputPath = resolveArtifactPath(sessionDirectory, manifest.artifacts.finalOutput.path);

  await verifyArtifact(
    tracePath,
    manifest.artifacts.trace.bytes,
    manifest.artifacts.trace.sha256,
    manifest.artifacts.trace.path,
  );
  await verifyArtifact(
    outputPath,
    manifest.artifacts.finalOutput.bytes,
    manifest.artifacts.finalOutput.sha256,
    manifest.artifacts.finalOutput.path,
  );

  const output = await readFile(outputPath, 'utf8').catch(() => {
    throw new TraceIntegrityError('TRACE_ARTIFACT_MISSING', {
      path: manifest.artifacts.finalOutput.path,
    });
  });
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!persistedJsonValueSchema.safeParse(parsed).success) {
      throw new TraceIntegrityError('TRACE_EVENT_INVALID', {
        path: manifest.artifacts.finalOutput.path,
      });
    }
  } catch (error) {
    if (error instanceof TraceIntegrityError) {
      throw error;
    }
    throw new TraceIntegrityError('TRACE_JSONL_TRUNCATED', {
      path: manifest.artifacts.finalOutput.path,
    });
  }

  return {
    manifest,
    events: await readTrace(tracePath, manifest),
    finalOutput: persistedJsonValueSchema.parse(JSON.parse(output) as unknown),
  };
}

async function loadManifest(sessionDirectory: string): Promise<RunManifest> {
  const path = join(sessionDirectory, 'run-manifest.json');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new TraceIntegrityError('TRACE_ARTIFACT_MISSING', { path: 'run-manifest.json' });
  }

  try {
    return parseRunManifest(JSON.parse(contents) as unknown);
  } catch {
    throw new TraceIntegrityError('TRACE_MANIFEST_INVALID', { path: 'run-manifest.json' });
  }
}

function resolveArtifactPath(sessionDirectory: string, path: string): string {
  if (!artifactRelativePathSchema.safeParse(path).success) {
    throw new TraceIntegrityError('TRACE_PATH_INVALID', { path });
  }
  const resolved = resolve(sessionDirectory, path);
  const relativePath = relative(sessionDirectory, resolved);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    throw new TraceIntegrityError('TRACE_PATH_INVALID', { path });
  }
  return resolved;
}

async function verifyArtifact(
  path: string,
  bytes: number,
  expectedHash: string,
  publicPath: string,
): Promise<void> {
  let contents: Buffer;
  try {
    const metadata = await stat(path);
    if (metadata.size !== bytes) {
      throw new TraceIntegrityError('TRACE_HASH_MISMATCH', { path: publicPath });
    }
    contents = await readFile(path);
  } catch (error) {
    if (error instanceof TraceIntegrityError) {
      throw error;
    }
    throw new TraceIntegrityError('TRACE_ARTIFACT_MISSING', {
      path: publicPath,
    });
  }
  const actualHash = createHash('sha256').update(contents).digest('hex');
  if (actualHash !== expectedHash) {
    throw new TraceIntegrityError('TRACE_HASH_MISMATCH');
  }
}

async function readTrace(path: string, manifest: RunManifest): Promise<readonly TraceEvent[]> {
  const events: TraceEvent[] = [];
  const eventIds = new Set<string>();
  const state: TraceState = {
    started: false,
    terminal: false,
    modelTurn: null,
    tools: new Map(),
  };
  let expectedSequence = 0;
  let line = 0;

  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const rawLine of lines) {
      line += 1;
      if (rawLine.trim().length === 0) {
        throw new TraceIntegrityError('TRACE_JSONL_TRUNCATED', { line });
      }

      let event: TraceEvent;
      try {
        event = parseTraceEvent(JSON.parse(rawLine) as unknown);
      } catch {
        throw new TraceIntegrityError('TRACE_EVENT_INVALID', { line });
      }

      validateEvent(event, manifest, state, expectedSequence, eventIds, line);
      events.push(event);
      eventIds.add(event.eventId);
      expectedSequence += 1;
    }
  } catch (error) {
    if (error instanceof TraceIntegrityError) {
      throw error;
    }
    throw new TraceIntegrityError('TRACE_ARTIFACT_MISSING', {
      path: manifest.artifacts.trace.path,
    });
  } finally {
    lines.close();
    input.destroy();
  }

  if (!state.started || !state.terminal || state.modelTurn !== null || state.tools.size > 0) {
    throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line: Math.max(line, 1) });
  }
  return events;
}

function validateEvent(
  event: TraceEvent,
  manifest: RunManifest,
  state: TraceState,
  expectedSequence: number,
  eventIds: ReadonlySet<string>,
  line: number,
): void {
  if (event.sessionId !== manifest.sessionId) {
    throw new TraceIntegrityError('TRACE_SESSION_MISMATCH', { line });
  }
  if (event.sequence !== expectedSequence) {
    throw new TraceIntegrityError('TRACE_SEQUENCE_INVALID', { line });
  }
  if (eventIds.has(event.eventId)) {
    throw new TraceIntegrityError('TRACE_EVENT_ID_DUPLICATE', { line });
  }
  if (state.terminal) {
    throw new TraceIntegrityError('TRACE_TERMINAL_INVALID', { line });
  }

  if (event.eventType === 'session.started') {
    if (state.started || event.turnIndex !== null) {
      throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
    }
    state.started = true;
    return;
  }
  if (!state.started) {
    throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
  }

  const terminal = event.eventType === 'session.completed' || event.eventType === 'session.failed';
  if (!terminal && event.turnIndex === null) {
    throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
  }
  if (terminal && event.turnIndex !== null) {
    throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
  }

  switch (event.eventType) {
    case 'model.requested':
      if (state.modelTurn !== null || event.payload.request.turnIndex !== event.turnIndex) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.modelTurn = event.turnIndex;
      break;
    case 'model.responded':
      if (state.modelTurn !== event.turnIndex) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.modelTurn = null;
      break;
    case 'tool.requested':
      if (state.tools.has(event.payload.callId)) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.tools.set(event.payload.callId, event.turnIndex as number);
      break;
    case 'tool.completed':
    case 'tool.failed':
      if (state.tools.get(event.payload.callId) !== event.turnIndex) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.tools.delete(event.payload.callId);
      break;
    case 'turn.completed':
      if (
        event.payload.turn.turnIndex !== event.turnIndex ||
        event.payload.turn.sessionId !== event.sessionId ||
        state.modelTurn === event.turnIndex ||
        [...state.tools.values()].includes(event.turnIndex)
      ) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      break;
    case 'session.completed':
      if (state.modelTurn !== null || state.tools.size > 0) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.terminal = true;
      break;
    case 'session.failed':
      if (state.tools.size > 0) {
        throw new TraceIntegrityError('TRACE_PAIRING_INVALID', { line });
      }
      state.modelTurn = null;
      state.terminal = true;
      break;
    case 'context.built':
      break;
  }
}
