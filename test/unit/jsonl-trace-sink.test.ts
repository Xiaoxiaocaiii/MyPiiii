import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJsonlTraceSink,
  JsonlTraceSinkError,
  type JsonlTraceFileHandle,
  type JsonlTraceFileSystem,
} from '../../src/observability/jsonl-trace-sink.js';
import { traceEventSchema, type TraceEvent } from '../../src/observability/trace-contracts.js';

const temporaryDirectories: string[] = [];
const timestamp = '2026-09-21T10:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryTracePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-harness-trace-'));
  temporaryDirectories.push(directory);
  return join(directory, 'trace.jsonl');
}

function sessionStarted(sequence = 0, sessionId = 'session-1'): TraceEvent {
  return traceEventSchema.parse({
    schemaVersion: 1,
    eventId: `event-${String(sequence)}`,
    sessionId,
    turnIndex: null,
    sequence,
    eventType: 'session.started',
    timestamp,
    payload: {
      configId: 'baseline',
      scenarioId: 'repo-qa',
      model: { provider: 'fake', name: 'deterministic-model' },
      inputMessage: 'Inspect the repository.',
    },
  });
}

function contextBuilt(sequence: number, sessionId = 'session-1'): TraceEvent {
  return traceEventSchema.parse({
    schemaVersion: 1,
    eventId: `event-${String(sequence)}`,
    sessionId,
    turnIndex: 0,
    sequence,
    eventType: 'context.built',
    timestamp,
    payload: {
      context: {
        schemaVersion: 1,
        systemRules: ['Return one action.'],
        taskInput: 'Inspect the repository.',
        recentTurns: [],
        observations: [],
        omittedTurnCount: 0,
        omittedObservationCount: 0,
      },
    },
  });
}

function sessionCompleted(sequence: number, sessionId = 'session-1'): TraceEvent {
  return traceEventSchema.parse({
    schemaVersion: 1,
    eventId: `event-${String(sequence)}`,
    sessionId,
    turnIndex: null,
    sequence,
    eventType: 'session.completed',
    timestamp,
    payload: {
      finalOutput: 'Done',
      turnCount: 1,
    },
  });
}

async function expectSinkError(
  promise: Promise<unknown>,
  code: JsonlTraceSinkError['code'],
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(JsonlTraceSinkError);
  expect(thrown).toMatchObject({ code });
}

function fakeFileSystem(handle: JsonlTraceFileHandle): JsonlTraceFileSystem {
  return {
    open: vi.fn(() => Promise.resolve(handle)),
  };
}

function successfulHandle() {
  const write = vi.fn<JsonlTraceFileHandle['write']>((_buffer, _offset, length) =>
    Promise.resolve({ bytesWritten: length }),
  );
  const sync = vi.fn<JsonlTraceFileHandle['sync']>(() => Promise.resolve());
  const close = vi.fn<JsonlTraceFileHandle['close']>(() => Promise.resolve());

  return {
    handle: { write, sync, close },
    write,
    sync,
    close,
  };
}

describe('JsonlTraceSink', () => {
  it('writes one validated UTF-8 event per line and synchronizes each append', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });
    const events = [sessionStarted(), contextBuilt(1), sessionCompleted(2)];

    for (const event of events) {
      await sink.append(event);
    }
    await sink.close();

    const contents = await readFile(path, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(
      contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(events);
  });

  it('serializes concurrent append calls in invocation order', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });

    await Promise.all([
      sink.append(sessionStarted()),
      sink.append(contextBuilt(1)),
      sink.append(sessionCompleted(2)),
    ]);
    await sink.close();

    const sequences = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    expect(sequences).toEqual([0, 1, 2]);
  });

  it('rejects sequence gaps and allows a corrected next event', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });
    await sink.append(sessionStarted());

    await expectSinkError(sink.append(sessionCompleted(2)), 'TRACE_FILE_SEQUENCE_INVALID');
    await expect(sink.append(sessionCompleted(1))).resolves.toBeUndefined();
    await sink.close();
  });

  it('rejects duplicate or decreasing sequences', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });
    await sink.append(sessionStarted());

    await expectSinkError(sink.append(contextBuilt(0)), 'TRACE_FILE_SEQUENCE_INVALID');
    await sink.close();
  });

  it('rejects events from another session', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });
    await sink.append(sessionStarted());

    await expectSinkError(sink.append(contextBuilt(1, 'session-2')), 'TRACE_FILE_SESSION_MISMATCH');
    await expect(sink.append(sessionCompleted(1))).resolves.toBeUndefined();
    await sink.close();
  });

  it('rejects appends after a terminal event', async () => {
    const path = await temporaryTracePath();
    const sink = await createJsonlTraceSink({ path });
    await sink.append(sessionStarted());
    await sink.append(sessionCompleted(1));

    await expectSinkError(sink.append(contextBuilt(2)), 'TRACE_FILE_TERMINATED');
    await sink.close();
  });

  it('rejects invalid events before writing', async () => {
    const { handle, write } = successfulHandle();
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });

    await expectSinkError(
      sink.append({ ...sessionStarted(), schemaVersion: 2 } as unknown as TraceEvent),
      'TRACE_FILE_EVENT_INVALID',
    );
    expect(write).not.toHaveBeenCalled();
    await sink.close();
  });

  it('does not overwrite an existing trace file', async () => {
    const path = await temporaryTracePath();
    await writeFile(path, 'existing\n', 'utf8');

    await expectSinkError(createJsonlTraceSink({ path }), 'TRACE_FILE_ALREADY_EXISTS');
    await expect(readFile(path, 'utf8')).resolves.toBe('existing\n');
  });

  it('normalizes open failures without exposing the path', async () => {
    const privatePath = join('missing-private-directory', 'trace.jsonl');
    let thrown: unknown;

    try {
      await createJsonlTraceSink({ path: privatePath });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'TRACE_FILE_OPEN_FAILED',
      message: 'The trace file could not be opened',
    });
    expect(String(thrown)).not.toContain(privatePath);
  });

  it('continues partial writes until the complete line is persisted', async () => {
    const { handle, write, sync } = successfulHandle();
    write
      .mockResolvedValueOnce({ bytesWritten: 2 })
      .mockImplementation((_buffer, _offset, length) => Promise.resolve({ bytesWritten: length }));
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });

    await sink.append(sessionStarted());

    expect(write).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledOnce();
    await sink.close();
  });

  it.each([0, Number.MAX_SAFE_INTEGER])(
    'rejects invalid write progress of %s bytes',
    async (bytesWritten) => {
      const { handle, write, sync } = successfulHandle();
      write.mockResolvedValueOnce({ bytesWritten });
      const sink = await createJsonlTraceSink({
        path: 'not-used',
        fileSystem: fakeFileSystem(handle),
      });

      await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_WRITE_FAILED');
      expect(sync).not.toHaveBeenCalled();
      await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_FAILED');
      await sink.close();
    },
  );

  it('marks a partially written trace as failed when a later write rejects', async () => {
    const { handle, write, sync } = successfulHandle();
    write
      .mockResolvedValueOnce({ bytesWritten: 2 })
      .mockRejectedValueOnce(new Error('private write failure'));
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });

    await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_WRITE_FAILED');
    await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_FAILED');
    expect(sync).not.toHaveBeenCalled();
    await sink.close();
  });

  it('normalizes synchronization failures and prevents later appends', async () => {
    const { handle, sync } = successfulHandle();
    sync.mockRejectedValueOnce(new Error('private sync failure'));
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });

    await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_SYNC_FAILED');
    await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_FAILED');
    await sink.close();
  });

  it('normalizes close failures and prevents later appends', async () => {
    const { handle, close } = successfulHandle();
    close.mockRejectedValueOnce(new Error('private close failure'));
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });
    await sink.append(sessionStarted());

    await expectSinkError(sink.close(), 'TRACE_FILE_CLOSE_FAILED');
    await expectSinkError(sink.append(contextBuilt(1)), 'TRACE_FILE_FAILED');
  });

  it('rejects appends after a successful close', async () => {
    const { handle } = successfulHandle();
    const sink = await createJsonlTraceSink({
      path: 'not-used',
      fileSystem: fakeFileSystem(handle),
    });
    await sink.close();

    await expectSinkError(sink.append(sessionStarted()), 'TRACE_FILE_CLOSED');
    await expectSinkError(sink.close(), 'TRACE_FILE_CLOSED');
  });
});
