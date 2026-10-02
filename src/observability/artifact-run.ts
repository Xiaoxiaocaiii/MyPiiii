import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { experimentConfigSchema, type ExperimentConfig } from '../core/config.js';
import { parseRunManifest, persistedJsonValueSchema, type RunManifest } from './trace-contracts.js';
import {
  createJsonlTraceSink,
  type JsonlTraceFileHandle,
  type JsonlTraceSink,
} from './jsonl-trace-sink.js';

const sessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const statusSchema = z.enum(['completed', 'failed']);

export const artifactFailureMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  code: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export type ArtifactFailureMarker = z.infer<typeof artifactFailureMarkerSchema>;

export interface ArtifactRunOptions {
  readonly directory: string;
  readonly sessionId: string;
  readonly config: ExperimentConfig;
  readonly createdAt?: Date;
}

export interface FinalizeArtifactRunOptions {
  readonly status: z.infer<typeof statusSchema>;
  readonly completedAt?: Date;
  readonly finalOutput: unknown;
}

export interface ArtifactRunPaths {
  readonly rootDirectory: string;
  readonly sessionDirectory: string;
  readonly trace: string;
  readonly finalOutput: string;
  readonly manifest: string;
  readonly failure: string;
}

export type ArtifactRunErrorCode =
  | 'ARTIFACT_DIRECTORY_EXISTS'
  | 'ARTIFACT_FAILURE_MARKER_WRITE_FAILED'
  | 'ARTIFACT_FINALIZED'
  | 'ARTIFACT_INPUT_INVALID'
  | 'ARTIFACT_MANIFEST_WRITE_FAILED'
  | 'ARTIFACT_OUTPUT_WRITE_FAILED'
  | 'ARTIFACT_PATH_INVALID'
  | 'ARTIFACT_TRACE_CLOSE_FAILED'
  | 'ARTIFACT_TRACE_OPEN_FAILED'
  | 'ARTIFACT_RUN_FAILED';

const errorMessages: Record<ArtifactRunErrorCode, string> = {
  ARTIFACT_DIRECTORY_EXISTS: 'The artifact session directory already exists',
  ARTIFACT_FAILURE_MARKER_WRITE_FAILED: 'The artifact failure marker could not be written',
  ARTIFACT_FINALIZED: 'The artifact run is already finalized',
  ARTIFACT_INPUT_INVALID: 'The artifact run input is invalid',
  ARTIFACT_MANIFEST_WRITE_FAILED: 'The run manifest could not be published',
  ARTIFACT_OUTPUT_WRITE_FAILED: 'The final output could not be published',
  ARTIFACT_PATH_INVALID: 'The artifact directory path is invalid',
  ARTIFACT_TRACE_CLOSE_FAILED: 'The trace file could not be closed',
  ARTIFACT_TRACE_OPEN_FAILED: 'The trace file could not be opened',
  ARTIFACT_RUN_FAILED: 'The artifact run cannot continue after a failure',
};

export class ArtifactRunError extends Error {
  override readonly name = 'ArtifactRunError';
  readonly code: ArtifactRunErrorCode;

  constructor(code: ArtifactRunErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export interface ArtifactRun {
  readonly paths: ArtifactRunPaths;
  readonly trace: JsonlTraceSink;
  finalize(options: FinalizeArtifactRunOptions): Promise<RunManifest>;
  abort(code?: string): Promise<void>;
}

export async function createArtifactRun(options: ArtifactRunOptions): Promise<ArtifactRun> {
  const config = experimentConfigSchema.safeParse(options.config);
  const sessionId = sessionIdSchema.safeParse(options.sessionId);
  if (!config.success || !sessionId.success || !isValidDate(options.createdAt)) {
    throw new ArtifactRunError('ARTIFACT_INPUT_INVALID');
  }
  if (options.directory.trim().length === 0) {
    throw new ArtifactRunError('ARTIFACT_PATH_INVALID');
  }

  const createdAt = options.createdAt ?? new Date();
  const rootDirectory = resolve(options.directory);
  const dateDirectory = join(rootDirectory, formatDate(createdAt));
  const sessionDirectory = join(dateDirectory, sessionId.data);

  try {
    await mkdir(dateDirectory, { recursive: true });
    await mkdir(sessionDirectory);
  } catch (error) {
    throw new ArtifactRunError(
      isExistsError(error) ? 'ARTIFACT_DIRECTORY_EXISTS' : 'ARTIFACT_PATH_INVALID',
    );
  }

  const paths: ArtifactRunPaths = {
    rootDirectory,
    sessionDirectory,
    trace: join(sessionDirectory, 'trace.jsonl'),
    finalOutput: join(sessionDirectory, 'final-output.json'),
    manifest: join(sessionDirectory, 'run-manifest.json'),
    failure: join(sessionDirectory, 'run-failure.json'),
  };

  let trace: JsonlTraceSink;
  try {
    trace = await createJsonlTraceSink({ path: paths.trace });
  } catch {
    await removeSessionDirectory(sessionDirectory);
    throw new ArtifactRunError('ARTIFACT_TRACE_OPEN_FAILED');
  }

  return new ManagedArtifactRun(paths, trace, config.data, createdAt);
}

class ManagedArtifactRun implements ArtifactRun {
  readonly paths: ArtifactRunPaths;
  readonly trace: JsonlTraceSink;
  readonly #config: ExperimentConfig;
  readonly #createdAt: Date;
  #finalized = false;

  constructor(
    paths: ArtifactRunPaths,
    trace: JsonlTraceSink,
    config: ExperimentConfig,
    createdAt: Date,
  ) {
    this.paths = paths;
    this.trace = trace;
    this.#config = config;
    this.#createdAt = createdAt;
  }

  async finalize(options: FinalizeArtifactRunOptions): Promise<RunManifest> {
    if (this.#finalized) {
      throw new ArtifactRunError('ARTIFACT_FINALIZED');
    }
    if (!statusSchema.safeParse(options.status).success || !isValidDate(options.completedAt)) {
      await this.#fail('ARTIFACT_INPUT_INVALID');
      throw new ArtifactRunError('ARTIFACT_INPUT_INVALID');
    }

    const completedAt = options.completedAt ?? new Date();
    const output = persistedJsonValueSchema.safeParse(options.finalOutput);
    if (!output.success || completedAt.getTime() < this.#createdAt.getTime()) {
      await this.#fail('ARTIFACT_INPUT_INVALID');
      throw new ArtifactRunError('ARTIFACT_INPUT_INVALID');
    }

    try {
      await this.#closeTrace();
      await writeAtomicJson(this.paths.finalOutput, output.data, 'ARTIFACT_OUTPUT_WRITE_FAILED');
      const manifest = await this.#buildManifest(options.status, completedAt);
      await writeAtomicJson(this.paths.manifest, manifest, 'ARTIFACT_MANIFEST_WRITE_FAILED');
      this.#finalized = true;
      return manifest;
    } catch (error) {
      await this.#recordFailure(
        error instanceof ArtifactRunError ? error.code : 'ARTIFACT_RUN_FAILED',
      );
      if (error instanceof ArtifactRunError) {
        throw error;
      }
      throw new ArtifactRunError('ARTIFACT_RUN_FAILED');
    }
  }

  async abort(code = 'ARTIFACT_RUN_FAILED'): Promise<void> {
    if (this.#finalized) {
      return;
    }
    await this.#fail(code);
  }

  async #fail(code: string): Promise<void> {
    try {
      await this.#closeTrace();
    } finally {
      await this.#recordFailure(code);
    }
  }

  async #closeTrace(): Promise<void> {
    try {
      await this.trace.close();
    } catch {
      throw new ArtifactRunError('ARTIFACT_TRACE_CLOSE_FAILED');
    }
  }

  async #buildManifest(
    status: z.infer<typeof statusSchema>,
    completedAt: Date,
  ): Promise<RunManifest> {
    const trace = await describeArtifact(this.paths.trace);
    const finalOutput = await describeArtifact(this.paths.finalOutput);
    const manifest = {
      schemaVersion: 1 as const,
      traceSchemaVersion: 1 as const,
      sessionId: basename(this.paths.sessionDirectory),
      configId: this.#config.configId,
      scenarioId: this.#config.scenarioId,
      model: {
        provider: this.#config.model.provider,
        name: this.#config.model.name,
      },
      status,
      createdAt: this.#createdAt.toISOString(),
      completedAt: completedAt.toISOString(),
      configSummary: {
        schemaVersion: 1 as const,
        runtime: this.#config.runtime,
        context: this.#config.context,
        tools: this.#config.tools,
      },
      artifacts: {
        trace: {
          ...trace,
          path: relative(this.paths.sessionDirectory, this.paths.trace),
        },
        finalOutput: {
          ...finalOutput,
          path: relative(this.paths.sessionDirectory, this.paths.finalOutput),
        },
      },
    };
    return parseRunManifest(manifest);
  }

  async #recordFailure(code: string): Promise<void> {
    let cleanupFailed = false;
    try {
      await Promise.all([
        removeIfExists(this.paths.finalOutput),
        removeIfExists(this.paths.manifest),
        removeTemporaryFiles(this.paths.sessionDirectory),
      ]);
    } catch {
      cleanupFailed = true;
    }
    try {
      await writeAtomicJson(
        this.paths.failure,
        {
          schemaVersion: 1,
          sessionId: basename(this.paths.sessionDirectory),
          code,
          createdAt: new Date().toISOString(),
        } satisfies ArtifactFailureMarker,
        'ARTIFACT_FAILURE_MARKER_WRITE_FAILED',
      );
    } catch {
      throw new ArtifactRunError('ARTIFACT_FAILURE_MARKER_WRITE_FAILED');
    }
    if (cleanupFailed) {
      throw new ArtifactRunError('ARTIFACT_RUN_FAILED');
    }
  }
}

async function writeAtomicJson(
  destination: string,
  value: unknown,
  errorCode: Extract<
    ArtifactRunErrorCode,
    | 'ARTIFACT_OUTPUT_WRITE_FAILED'
    | 'ARTIFACT_MANIFEST_WRITE_FAILED'
    | 'ARTIFACT_FAILURE_MARKER_WRITE_FAILED'
  >,
): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle: JsonlTraceFileHandle | undefined;
  try {
    handle = await open(temporary, 'wx');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
        throw new Error('Invalid write progress');
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch {
    try {
      await handle?.close();
    } catch {
      // The stable write error below covers close failures as well.
    }
    await removeIfExists(temporary);
    throw new ArtifactRunError(errorCode);
  }
}

async function describeArtifact(path: string): Promise<{ bytes: number; sha256: string }> {
  const [metadata, contents] = await Promise.all([stat(path), readFile(path)]);
  return {
    bytes: metadata.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

async function removeTemporaryFiles(directory: string): Promise<void> {
  const names = ['final-output.json', 'run-manifest.json'];
  await Promise.all(names.map((name) => removeIfExists(join(directory, name))));
}

async function removeSessionDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isValidDate(value: Date | undefined): boolean {
  return value === undefined || Number.isFinite(value.getTime());
}

function isExistsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('\\') + 1).slice(path.lastIndexOf('/') + 1);
}
