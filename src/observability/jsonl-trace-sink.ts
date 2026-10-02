import { open } from 'node:fs/promises';

import { parseTraceEvent, type TraceEvent } from './trace-contracts.js';
import type { TraceSink } from './trace-recorder.js';

export interface JsonlTraceFileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface JsonlTraceFileSystem {
  open(path: string, flags: 'ax'): Promise<JsonlTraceFileHandle>;
}

export interface CreateJsonlTraceSinkOptions {
  readonly path: string;
  readonly fileSystem?: JsonlTraceFileSystem;
}

export type JsonlTraceSinkErrorCode =
  | 'TRACE_FILE_ALREADY_EXISTS'
  | 'TRACE_FILE_CLOSE_FAILED'
  | 'TRACE_FILE_CLOSED'
  | 'TRACE_FILE_EVENT_INVALID'
  | 'TRACE_FILE_FAILED'
  | 'TRACE_FILE_OPEN_FAILED'
  | 'TRACE_FILE_SEQUENCE_INVALID'
  | 'TRACE_FILE_SESSION_MISMATCH'
  | 'TRACE_FILE_SYNC_FAILED'
  | 'TRACE_FILE_TERMINATED'
  | 'TRACE_FILE_WRITE_FAILED';

const errorMessages: Record<JsonlTraceSinkErrorCode, string> = {
  TRACE_FILE_ALREADY_EXISTS: 'The trace file already exists',
  TRACE_FILE_CLOSE_FAILED: 'The trace file could not be closed',
  TRACE_FILE_CLOSED: 'The trace file is closed',
  TRACE_FILE_EVENT_INVALID: 'The trace event is invalid',
  TRACE_FILE_FAILED: 'The trace file cannot continue after an I/O failure',
  TRACE_FILE_OPEN_FAILED: 'The trace file could not be opened',
  TRACE_FILE_SEQUENCE_INVALID: 'The trace event sequence is invalid',
  TRACE_FILE_SESSION_MISMATCH: 'The trace event belongs to another session',
  TRACE_FILE_SYNC_FAILED: 'The trace file could not be synchronized',
  TRACE_FILE_TERMINATED: 'The trace file already contains a terminal event',
  TRACE_FILE_WRITE_FAILED: 'The trace event could not be written',
};

export class JsonlTraceSinkError extends Error {
  override readonly name = 'JsonlTraceSinkError';
  readonly code: JsonlTraceSinkErrorCode;

  constructor(code: JsonlTraceSinkErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

const nodeFileSystem: JsonlTraceFileSystem = {
  async open(path, flags) {
    const handle = await open(path, flags);
    return {
      async write(buffer, offset, length, position) {
        const result = await handle.write(buffer, offset, length, position);
        return { bytesWritten: result.bytesWritten };
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
};

export async function createJsonlTraceSink(
  options: CreateJsonlTraceSinkOptions,
): Promise<JsonlTraceSink> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  let handle: JsonlTraceFileHandle;

  try {
    handle = await fileSystem.open(options.path, 'ax');
  } catch (error) {
    throw new JsonlTraceSinkError(
      isFileExistsError(error) ? 'TRACE_FILE_ALREADY_EXISTS' : 'TRACE_FILE_OPEN_FAILED',
    );
  }

  return new JsonlTraceSink(handle);
}

export class JsonlTraceSink implements TraceSink {
  readonly #handle: JsonlTraceFileHandle;
  readonly #encoder = new TextEncoder();
  #tail: Promise<void> = Promise.resolve();
  #sessionId: string | null = null;
  #nextSequence = 0;
  #terminal = false;
  #closed = false;
  #failed = false;

  constructor(handle: JsonlTraceFileHandle) {
    this.#handle = handle;
  }

  append(event: TraceEvent): Promise<void> {
    const operation = this.#tail.then(() => this.#appendOne(event));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    const operation = this.#tail.then(() => this.#close());
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #appendOne(value: TraceEvent): Promise<void> {
    this.#requireWritable();

    let event: TraceEvent;
    try {
      event = parseTraceEvent(value);
    } catch {
      throw new JsonlTraceSinkError('TRACE_FILE_EVENT_INVALID');
    }

    this.#validateOrder(event);
    const bytes = this.#encoder.encode(`${JSON.stringify(event)}\n`);

    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await this.#handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        );
        if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
          throw new Error('Invalid write progress');
        }
        offset += bytesWritten;
      }
    } catch {
      this.#failed = true;
      throw new JsonlTraceSinkError('TRACE_FILE_WRITE_FAILED');
    }

    try {
      await this.#handle.sync();
    } catch {
      this.#failed = true;
      throw new JsonlTraceSinkError('TRACE_FILE_SYNC_FAILED');
    }

    this.#sessionId ??= event.sessionId;
    this.#nextSequence += 1;
    this.#terminal =
      event.eventType === 'session.completed' || event.eventType === 'session.failed';
  }

  async #close(): Promise<void> {
    if (this.#closed) {
      throw new JsonlTraceSinkError('TRACE_FILE_CLOSED');
    }

    try {
      await this.#handle.close();
      this.#closed = true;
    } catch {
      this.#failed = true;
      throw new JsonlTraceSinkError('TRACE_FILE_CLOSE_FAILED');
    }
  }

  #requireWritable(): void {
    if (this.#failed) {
      throw new JsonlTraceSinkError('TRACE_FILE_FAILED');
    }
    if (this.#closed) {
      throw new JsonlTraceSinkError('TRACE_FILE_CLOSED');
    }
    if (this.#terminal) {
      throw new JsonlTraceSinkError('TRACE_FILE_TERMINATED');
    }
  }

  #validateOrder(event: TraceEvent): void {
    if (event.sequence !== this.#nextSequence) {
      throw new JsonlTraceSinkError('TRACE_FILE_SEQUENCE_INVALID');
    }
    if (this.#sessionId !== null && event.sessionId !== this.#sessionId) {
      throw new JsonlTraceSinkError('TRACE_FILE_SESSION_MISMATCH');
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
