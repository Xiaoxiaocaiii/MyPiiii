import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { artifactRelativePathSchema } from './trace-contracts.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const timestampSchema = z.string().datetime({ offset: true });

export const runIndexStatusSchema = z.enum(['running', 'completed', 'failed']);
export type RunIndexStatus = z.infer<typeof runIndexStatusSchema>;

export const createRunIndexEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: identifierSchema,
  configId: identifierSchema,
  scenarioId: identifierSchema,
  model: z.strictObject({
    provider: identifierSchema,
    name: z.string().trim().min(1).max(256),
  }),
  createdAt: timestampSchema,
  artifacts: z.strictObject({
    manifest: artifactRelativePathSchema,
    trace: artifactRelativePathSchema,
    finalOutput: artifactRelativePathSchema,
  }),
});

export type CreateRunIndexEntry = z.infer<typeof createRunIndexEntrySchema>;

export const finishRunIndexEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: identifierSchema,
  status: z.enum(['completed', 'failed']),
  completedAt: timestampSchema,
});

export type FinishRunIndexEntry = z.infer<typeof finishRunIndexEntrySchema>;

export const runIndexEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sessionId: identifierSchema,
    status: runIndexStatusSchema,
    configId: identifierSchema,
    scenarioId: identifierSchema,
    model: z.strictObject({
      provider: identifierSchema,
      name: z.string().trim().min(1).max(256),
    }),
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    artifacts: z.strictObject({
      manifest: artifactRelativePathSchema,
      trace: artifactRelativePathSchema,
      finalOutput: artifactRelativePathSchema,
    }),
  })
  .superRefine((entry, context) => {
    if ((entry.status === 'running') !== (entry.completedAt === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Run status and completion time are inconsistent',
        path: ['completedAt'],
      });
    }
    if (entry.completedAt !== null && Date.parse(entry.completedAt) < Date.parse(entry.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Completion time must not precede creation time',
        path: ['completedAt'],
      });
    }
  });

export type RunIndexEntry = z.infer<typeof runIndexEntrySchema>;

export type SqliteRunIndexErrorCode =
  | 'RUN_INDEX_CLOSE_FAILED'
  | 'RUN_INDEX_DUPLICATE_SESSION'
  | 'RUN_INDEX_INPUT_INVALID'
  | 'RUN_INDEX_MIGRATION_FAILED'
  | 'RUN_INDEX_NOT_FOUND'
  | 'RUN_INDEX_OPEN_FAILED'
  | 'RUN_INDEX_OPERATION_FAILED'
  | 'RUN_INDEX_QUERY_FAILED'
  | 'RUN_INDEX_TRANSITION_INVALID';

const errorMessages: Record<SqliteRunIndexErrorCode, string> = {
  RUN_INDEX_CLOSE_FAILED: 'The run index could not be closed',
  RUN_INDEX_DUPLICATE_SESSION: 'The run session already exists',
  RUN_INDEX_INPUT_INVALID: 'The run index input is invalid',
  RUN_INDEX_MIGRATION_FAILED: 'The run index schema could not be migrated',
  RUN_INDEX_NOT_FOUND: 'The run session was not found',
  RUN_INDEX_OPEN_FAILED: 'The run index could not be opened',
  RUN_INDEX_OPERATION_FAILED: 'The run index operation failed',
  RUN_INDEX_QUERY_FAILED: 'The run index query failed',
  RUN_INDEX_TRANSITION_INVALID: 'The run status transition is invalid',
};

export class SqliteRunIndexError extends Error {
  override readonly name = 'SqliteRunIndexError';
  readonly code: SqliteRunIndexErrorCode;

  constructor(code: SqliteRunIndexErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface CreateSqliteRunIndexOptions {
  readonly path: string;
}

export function createSqliteRunIndex(options: CreateSqliteRunIndexOptions): SqliteRunIndex {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(options.path);
  } catch {
    throw new SqliteRunIndexError('RUN_INDEX_OPEN_FAILED');
  }

  try {
    database.exec('PRAGMA foreign_keys = ON');
    migrate(database);
    return new SqliteRunIndex(database);
  } catch (error) {
    try {
      database.close();
    } catch {
      // The migration error remains the stable public failure.
    }
    if (error instanceof SqliteRunIndexError) {
      throw error;
    }
    throw new SqliteRunIndexError('RUN_INDEX_MIGRATION_FAILED');
  }
}

export class SqliteRunIndex {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  createRun(value: CreateRunIndexEntry): RunIndexEntry {
    const parsed = createRunIndexEntrySchema.safeParse(value);
    if (!parsed.success) {
      throw new SqliteRunIndexError('RUN_INDEX_INPUT_INVALID');
    }

    try {
      return this.#transaction(() => {
        if (this.#selectRow(parsed.data.sessionId) !== undefined) {
          throw new SqliteRunIndexError('RUN_INDEX_DUPLICATE_SESSION');
        }

        this.#database
          .prepare(
            `INSERT INTO runs (
              session_id, status, config_id, scenario_id, model_provider, model_name,
              created_at, completed_at, manifest_path, trace_path, final_output_path
            ) VALUES (?, 'running', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(
            parsed.data.sessionId,
            parsed.data.configId,
            parsed.data.scenarioId,
            parsed.data.model.provider,
            parsed.data.model.name,
            parsed.data.createdAt,
            parsed.data.artifacts.manifest,
            parsed.data.artifacts.trace,
            parsed.data.artifacts.finalOutput,
          );

        return this.#parseRow(this.#selectRequiredRow(parsed.data.sessionId));
      });
    } catch (error) {
      throw normalizeOperationError(error);
    }
  }

  finishRun(value: FinishRunIndexEntry): RunIndexEntry {
    const parsed = finishRunIndexEntrySchema.safeParse(value);
    if (!parsed.success) {
      throw new SqliteRunIndexError('RUN_INDEX_INPUT_INVALID');
    }

    try {
      return this.#transaction(() => {
        const current = this.#parseRow(this.#selectRequiredRow(parsed.data.sessionId));
        if (current.status !== 'running') {
          throw new SqliteRunIndexError('RUN_INDEX_TRANSITION_INVALID');
        }
        if (Date.parse(parsed.data.completedAt) < Date.parse(current.createdAt)) {
          throw new SqliteRunIndexError('RUN_INDEX_INPUT_INVALID');
        }

        const result = this.#database
          .prepare(
            `UPDATE runs
             SET status = ?, completed_at = ?
             WHERE session_id = ? AND status = 'running'`,
          )
          .run(parsed.data.status, parsed.data.completedAt, parsed.data.sessionId);
        if (result.changes !== 1) {
          throw new SqliteRunIndexError('RUN_INDEX_TRANSITION_INVALID');
        }

        return this.#parseRow(this.#selectRequiredRow(parsed.data.sessionId));
      });
    } catch (error) {
      throw normalizeOperationError(error);
    }
  }

  getRun(sessionId: string): RunIndexEntry | undefined {
    const parsed = identifierSchema.safeParse(sessionId);
    if (!parsed.success) {
      throw new SqliteRunIndexError('RUN_INDEX_INPUT_INVALID');
    }

    try {
      const row = this.#selectRow(parsed.data);
      return row === undefined ? undefined : this.#parseRow(row);
    } catch (error) {
      if (error instanceof SqliteRunIndexError) {
        throw error;
      }
      throw new SqliteRunIndexError('RUN_INDEX_QUERY_FAILED');
    }
  }

  listRuns(status?: RunIndexStatus): readonly RunIndexEntry[] {
    if (status !== undefined && !runIndexStatusSchema.safeParse(status).success) {
      throw new SqliteRunIndexError('RUN_INDEX_INPUT_INVALID');
    }

    try {
      const rows =
        status === undefined
          ? this.#database
              .prepare('SELECT * FROM runs ORDER BY created_at ASC, session_id ASC')
              .all()
          : this.#database
              .prepare(
                'SELECT * FROM runs WHERE status = ? ORDER BY created_at ASC, session_id ASC',
              )
              .all(status);
      return rows.map((row) => this.#parseRow(row));
    } catch (error) {
      if (error instanceof SqliteRunIndexError) {
        throw error;
      }
      throw new SqliteRunIndexError('RUN_INDEX_QUERY_FAILED');
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#database.close();
      this.#closed = true;
    } catch {
      throw new SqliteRunIndexError('RUN_INDEX_CLOSE_FAILED');
    }
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        throw new SqliteRunIndexError('RUN_INDEX_OPERATION_FAILED');
      }
      throw error;
    }
  }

  #selectRequiredRow(sessionId: string): Record<string, unknown> {
    const row = this.#selectRow(sessionId);
    if (row === undefined) {
      throw new SqliteRunIndexError('RUN_INDEX_NOT_FOUND');
    }
    return row;
  }

  #selectRow(sessionId: string): Record<string, unknown> | undefined {
    return this.#database.prepare('SELECT * FROM runs WHERE session_id = ?').get(sessionId);
  }

  #parseRow(row: Record<string, unknown>): RunIndexEntry {
    const result = runIndexEntrySchema.safeParse({
      schemaVersion: 1,
      sessionId: row['session_id'],
      status: row['status'],
      configId: row['config_id'],
      scenarioId: row['scenario_id'],
      model: {
        provider: row['model_provider'],
        name: row['model_name'],
      },
      createdAt: row['created_at'],
      completedAt: row['completed_at'],
      artifacts: {
        manifest: row['manifest_path'],
        trace: row['trace_path'],
        finalOutput: row['final_output_path'],
      },
    });
    if (!result.success) {
      throw new SqliteRunIndexError('RUN_INDEX_QUERY_FAILED');
    }
    return result.data;
  }
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const latest = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.[
    'version'
  ];
  if (typeof latest === 'number' && latest > 1) {
    throw new SqliteRunIndexError('RUN_INDEX_MIGRATION_FAILED');
  }
  if (latest === 1) {
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE runs (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        config_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        manifest_path TEXT NOT NULL,
        trace_path TEXT NOT NULL,
        final_output_path TEXT NOT NULL,
        CHECK (
          (status = 'running' AND completed_at IS NULL) OR
          (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX runs_status_created_at
        ON runs (status, created_at, session_id);
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)')
      .run('2026-09-21T00:00:00.000Z');
    database.exec('COMMIT');
  } catch {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The stable migration error below covers rollback failure as well.
    }
    throw new SqliteRunIndexError('RUN_INDEX_MIGRATION_FAILED');
  }
}

function normalizeOperationError(error: unknown): SqliteRunIndexError {
  return error instanceof SqliteRunIndexError
    ? error
    : new SqliteRunIndexError('RUN_INDEX_OPERATION_FAILED');
}
