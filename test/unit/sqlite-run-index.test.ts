import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSqliteRunIndex,
  runIndexEntrySchema,
  SqliteRunIndexError,
  type CreateRunIndexEntry,
} from '../../src/observability/sqlite-run-index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-harness-index-'));
  temporaryDirectories.push(directory);
  return join(directory, 'runs.sqlite');
}

function runInput(
  sessionId = 'session-1',
  createdAt = '2026-09-21T10:00:00.000Z',
): CreateRunIndexEntry {
  return {
    schemaVersion: 1,
    sessionId,
    configId: 'baseline',
    scenarioId: 'repo-qa',
    model: {
      provider: 'fake',
      name: 'deterministic-model',
    },
    createdAt,
    artifacts: {
      manifest: `${sessionId}/run-manifest.json`,
      trace: `${sessionId}/trace.jsonl`,
      finalOutput: `${sessionId}/final-output.json`,
    },
  };
}

function expectIndexError(operation: () => unknown, code: SqliteRunIndexError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SqliteRunIndexError);
  expect(thrown).toMatchObject({ code });
}

describe('SqliteRunIndex migrations', () => {
  it('creates the versioned minimal schema on first open', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    index.close();

    const database = new DatabaseSync(path);
    const migration = database.prepare('SELECT version FROM schema_migrations').get() as {
      version: number;
    };
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row['name']);
    const runColumns = database
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => row['name']);
    database.close();

    expect(migration.version).toBe(1);
    expect(tables).toEqual(['runs', 'schema_migrations']);
    expect(runColumns).toEqual([
      'session_id',
      'status',
      'config_id',
      'scenario_id',
      'model_provider',
      'model_name',
      'created_at',
      'completed_at',
      'manifest_path',
      'trace_path',
      'final_output_path',
    ]);
  });

  it('reopens an already migrated database without duplicating migration state', async () => {
    const path = await temporaryDatabasePath();
    createSqliteRunIndex({ path }).close();
    createSqliteRunIndex({ path }).close();

    const database = new DatabaseSync(path);
    const count = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
      count: number;
    };
    database.close();

    expect(count.count).toBe(1);
  });

  it('rejects an unknown newer schema version', async () => {
    const path = await temporaryDatabasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (2, '2026-09-21T00:00:00.000Z');
    `);
    database.close();

    expectIndexError(() => createSqliteRunIndex({ path }), 'RUN_INDEX_MIGRATION_FAILED');
  });

  it('rolls back a partially applied migration and normalizes the failure', async () => {
    const path = await temporaryDatabasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT);
      INSERT INTO schema_migrations (version) VALUES ('unexpected');
      CREATE TABLE runs (legacy_column TEXT);
    `);
    database.close();

    let thrown: unknown;
    try {
      createSqliteRunIndex({ path });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'RUN_INDEX_MIGRATION_FAILED',
      message: 'The run index schema could not be migrated',
    });
    expect(String(thrown)).not.toContain(path);

    const reopened = new DatabaseSync(path);
    expect(reopened.prepare('SELECT version FROM schema_migrations').get()).toEqual({
      version: 'unexpected',
    });
    expect(
      reopened
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'runs'`,
        )
        .get(),
    ).toEqual({ name: 'runs' });
    reopened.close();
  });
});

describe('SqliteRunIndex lifecycle', () => {
  it('creates, completes, and queries a run', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });

    const created = index.createRun(runInput());
    const completed = index.finishRun({
      schemaVersion: 1,
      sessionId: 'session-1',
      status: 'completed',
      completedAt: '2026-09-21T10:00:01.000Z',
    });

    expect(created).toMatchObject({ status: 'running', completedAt: null });
    expect(completed).toMatchObject({
      status: 'completed',
      completedAt: '2026-09-21T10:00:01.000Z',
    });
    expect(index.getRun('session-1')).toEqual(completed);
    index.close();
  });

  it('supports a failed terminal state', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    index.createRun(runInput());

    expect(
      index.finishRun({
        schemaVersion: 1,
        sessionId: 'session-1',
        status: 'failed',
        completedAt: '2026-09-21T10:00:01.000Z',
      }),
    ).toMatchObject({ status: 'failed' });
    index.close();
  });

  it('rejects duplicate session IDs without changing the original row', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    const original = index.createRun(runInput());

    expectIndexError(
      () => index.createRun({ ...runInput(), configId: 'replacement' }),
      'RUN_INDEX_DUPLICATE_SESSION',
    );
    expect(index.getRun('session-1')).toEqual(original);
    index.close();
  });

  it('rejects repeated or reversed terminal transitions', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    index.createRun(runInput());
    const completed = index.finishRun({
      schemaVersion: 1,
      sessionId: 'session-1',
      status: 'completed',
      completedAt: '2026-09-21T10:00:01.000Z',
    });

    expectIndexError(
      () =>
        index.finishRun({
          schemaVersion: 1,
          sessionId: 'session-1',
          status: 'failed',
          completedAt: '2026-09-21T10:00:02.000Z',
        }),
      'RUN_INDEX_TRANSITION_INVALID',
    );
    expect(index.getRun('session-1')).toEqual(completed);
    index.close();
  });

  it('rolls back a failed completion and keeps the run active', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    const running = index.createRun(runInput());

    expectIndexError(
      () =>
        index.finishRun({
          schemaVersion: 1,
          sessionId: 'session-1',
          status: 'completed',
          completedAt: '2026-09-21T09:59:59.000Z',
        }),
      'RUN_INDEX_INPUT_INVALID',
    );
    expect(index.getRun('session-1')).toEqual(running);
    index.close();
  });

  it('preserves a running state when SQLite ignores a terminal update', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    const running = index.createRun(runInput());
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER ignore_run_update
      BEFORE UPDATE ON runs
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    database.close();

    expectIndexError(
      () =>
        index.finishRun({
          schemaVersion: 1,
          sessionId: 'session-1',
          status: 'completed',
          completedAt: '2026-09-21T10:00:01.000Z',
        }),
      'RUN_INDEX_TRANSITION_INVALID',
    );
    expect(index.getRun('session-1')).toEqual(running);
    index.close();
  });

  it('reports a missing session without leaking database details', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });

    expectIndexError(
      () =>
        index.finishRun({
          schemaVersion: 1,
          sessionId: 'missing-session',
          status: 'failed',
          completedAt: '2026-09-21T10:00:00.000Z',
        }),
      'RUN_INDEX_NOT_FOUND',
    );
    index.close();
  });

  it('lists runs deterministically and filters by status', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    index.createRun(runInput('session-b', '2026-09-21T10:00:01.000Z'));
    index.createRun(runInput('session-a', '2026-09-21T10:00:00.000Z'));
    index.finishRun({
      schemaVersion: 1,
      sessionId: 'session-a',
      status: 'completed',
      completedAt: '2026-09-21T10:00:02.000Z',
    });

    expect(index.listRuns().map((run) => run.sessionId)).toEqual(['session-a', 'session-b']);
    expect(index.listRuns('running').map((run) => run.sessionId)).toEqual(['session-b']);
    expect(index.listRuns('completed').map((run) => run.sessionId)).toEqual(['session-a']);
    expect(index.getRun('missing-session')).toBeUndefined();
    index.close();
  });

  it.each([
    ['invalid session ID', { ...runInput(), sessionId: '../private' }],
    [
      'absolute artifact path',
      {
        ...runInput(),
        artifacts: { ...runInput().artifacts, trace: 'C:/private/trace.jsonl' },
      },
    ],
    ['unsupported schema version', { ...runInput(), schemaVersion: 2 }],
  ])('rejects %s before touching SQLite', async (_name, input) => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });

    expectIndexError(
      () => index.createRun(input as CreateRunIndexEntry),
      'RUN_INDEX_INPUT_INVALID',
    );
    expect(index.listRuns()).toEqual([]);
    index.close();
  });

  it('normalizes open failures without exposing the database path', () => {
    const privatePath = join('missing-private-directory', 'runs.sqlite');
    let thrown: unknown;

    try {
      createSqliteRunIndex({ path: privatePath });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'RUN_INDEX_OPEN_FAILED',
      message: 'The run index could not be opened',
    });
    expect(String(thrown)).not.toContain(privatePath);
  });

  it('normalizes query and operation errors after an external schema change', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    const database = new DatabaseSync(path);
    database.exec('DROP TABLE runs');
    database.close();

    expectIndexError(() => index.getRun('session-1'), 'RUN_INDEX_QUERY_FAILED');
    expectIndexError(() => index.listRuns(), 'RUN_INDEX_QUERY_FAILED');
    expectIndexError(() => index.createRun(runInput()), 'RUN_INDEX_OPERATION_FAILED');
    expectIndexError(
      () =>
        index.finishRun({
          schemaVersion: 1,
          sessionId: 'session-1',
          status: 'failed',
          completedAt: '2026-09-21T10:00:01.000Z',
        }),
      'RUN_INDEX_OPERATION_FAILED',
    );
    index.close();
  });

  it('rejects persisted rows whose status and completion timestamp disagree', async () => {
    const path = await temporaryDatabasePath();
    const index = createSqliteRunIndex({ path });
    index.createRun(runInput());
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA ignore_check_constraints = ON;
      UPDATE runs
      SET status = 'completed', completed_at = NULL
      WHERE session_id = 'session-1';
    `);
    database.close();

    expectIndexError(() => index.getRun('session-1'), 'RUN_INDEX_QUERY_FAILED');
    expectIndexError(() => index.listRuns(), 'RUN_INDEX_QUERY_FAILED');
    index.close();
  });

  it('validates indexed row status and completion chronology', () => {
    const running = {
      schemaVersion: 1,
      sessionId: 'session-1',
      status: 'running',
      configId: 'baseline',
      scenarioId: 'repo-qa',
      model: { provider: 'fake', name: 'deterministic-model' },
      createdAt: '2026-09-21T10:00:00.000Z',
      completedAt: null,
      artifacts: runInput().artifacts,
    };

    expect(runIndexEntrySchema.safeParse(running).success).toBe(true);
    expect(
      runIndexEntrySchema.safeParse({
        ...running,
        status: 'completed',
        completedAt: null,
      }).success,
    ).toBe(false);
    expect(
      runIndexEntrySchema.safeParse({
        ...running,
        status: 'completed',
        completedAt: '2026-09-21T09:59:59.000Z',
      }).success,
    ).toBe(false);
  });
});
