import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

const runFile = promisify(execFile);

export const realEvalSourcePaths = Object.freeze([
  'src/core/config.ts',
  'src/core/context-window.ts',
  'src/core/contracts.ts',
  'src/core/deepseek-model.ts',
  'src/core/model.ts',
  'src/core/runtime.ts',
  'src/core/tool-permissions.ts',
  'src/core/tool-registry.ts',
  'src/core/tool-runtime.ts',
  'src/core/tool.ts',
  'src/observability/artifact-run.ts',
  'src/observability/jsonl-trace-sink.ts',
  'src/observability/sqlite-run-index.ts',
  'src/observability/trace-consistency.ts',
  'src/observability/trace-contracts.ts',
  'src/observability/trace-loader.ts',
  'src/observability/trace-recorder.ts',
  'src/observability/trace-replay.ts',
] as const);

const allowedFiles = new Set<string>(realEvalSourcePaths);
const allowedDirectories = new Set(['', 'src', 'src/core', 'src/observability']);
const maxSourceFileBytes = 512 * 1024;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const sourceOriginSchema = z.strictObject({
  gitStatus: z.string().max(8),
  baseSha256: sha256Schema.nullable(),
  diffSha256: sha256Schema.nullable(),
});

const snapshotFileSchema = z.strictObject({
  path: z.string().refine((path) => allowedFiles.has(path)),
  bytes: z.number().int().positive().max(maxSourceFileBytes),
  sha256: sha256Schema,
  origin: sourceOriginSchema,
});

export const realEvalSnapshotManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotId: sha256Schema,
    baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
    workingTreeDiffSha256: sha256Schema,
    createdAt: z.string().datetime({ offset: true }),
    files: z.array(snapshotFileSchema).length(realEvalSourcePaths.length),
  })
  .superRefine((manifest, context) => {
    const expectedPaths = [...realEvalSourcePaths];
    if (manifest.files.some((file, index) => file.path !== expectedPaths[index])) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot files do not match the fixed source allowlist',
        path: ['files'],
      });
    }
    if (computeRealEvalWorkingTreeDiffSha256(manifest.files) !== manifest.workingTreeDiffSha256) {
      context.addIssue({
        code: 'custom',
        message: 'Working-tree provenance does not match its identity',
        path: ['workingTreeDiffSha256'],
      });
    }
    if (computeRealEvalSnapshotId(manifest) !== manifest.snapshotId) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot identity does not match its manifest',
        path: ['snapshotId'],
      });
    }
  });

export type RealEvalSnapshotManifest = z.infer<typeof realEvalSnapshotManifestSchema>;

export interface RealEvalSourceOrigin {
  readonly gitStatus: string;
  readonly baseSha256: string | null;
  readonly diffSha256: string | null;
}

export interface CreateRealEvalSnapshotOptions {
  readonly repositoryRoot: string;
  readonly snapshotsDirectory: string;
  readonly baseRevision: string;
  readonly workingTreeDiffSha256: string;
  readonly origins: ReadonlyMap<string, RealEvalSourceOrigin>;
  readonly createdAt?: Date;
}

export interface RealEvalSnapshot {
  readonly rootDirectory: string;
  readonly manifestPath: string;
  readonly manifest: RealEvalSnapshotManifest;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface SnapshotCapability {
  readonly directories: ReadonlyMap<string, FileIdentity>;
  readonly files: ReadonlyMap<string, { readonly identity: FileIdentity; readonly sha256: string }>;
}

class RealEvalSnapshotBoundaryError extends Error {
  constructor(
    readonly code: 'BOUNDARY_VIOLATION' | 'INTEGRITY_FAILED' | 'SOURCE_INVALID',
    message: string,
  ) {
    super(message);
  }
}

export class RealEvalSnapshotError extends Error {
  override readonly name = 'RealEvalSnapshotError';

  constructor(
    readonly code:
      | 'ABORTED'
      | 'BOUNDARY_VIOLATION'
      | 'INVALID_MANIFEST'
      | 'SNAPSHOT_EXISTS'
      | 'SNAPSHOT_READ_FAILED',
    message: string,
  ) {
    super(message);
  }
}

const snapshotCapabilities = new WeakMap<RealEvalSnapshot, SnapshotCapability>();

function digest(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function identityOf(stats: BigIntStats): FileIdentity {
  if (stats.dev === 0n || stats.ino === 0n) {
    throw new RealEvalSnapshotBoundaryError(
      'INTEGRITY_FAILED',
      'The file system does not expose a stable file identity',
    );
  }
  return { device: stats.dev, inode: stats.ino };
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.device === expected.device && actual.inode === expected.inode;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new RealEvalSnapshotBoundaryError('SOURCE_INVALID', 'The snapshot read was aborted');
  }
}

async function rejectReparsePoint(path: string, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    await runFile('fsutil.exe', ['reparsepoint', 'query', path], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throwIfAborted(signal);
    const commandError = error as { code?: unknown; stdout?: unknown };
    if (commandError.code === 1 && String(commandError.stdout).includes('4390')) {
      return;
    }
    if (commandError.code === 0) {
      throw new RealEvalSnapshotBoundaryError(
        'BOUNDARY_VIOLATION',
        'Reparse points are not allowed in the snapshot',
      );
    }
    throw new RealEvalSnapshotBoundaryError(
      'BOUNDARY_VIOLATION',
      'Unable to verify the Windows reparse-point state',
    );
  }

  throwIfAborted(signal);
  throw new RealEvalSnapshotBoundaryError(
    'BOUNDARY_VIOLATION',
    'Reparse points are not allowed in the snapshot',
  );
}

async function inspectEntry(
  path: string,
  kind: 'directory' | 'file',
  expectedIdentity?: FileIdentity,
  checkReparsePoint = true,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  throwIfAborted(signal);
  if (checkReparsePoint) {
    await rejectReparsePoint(path, signal);
  }

  const stats = await lstat(path, { bigint: true });
  throwIfAborted(signal);
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) {
    throw new RealEvalSnapshotBoundaryError(
      'BOUNDARY_VIOLATION',
      'The snapshot contains an unexpected file-system entry',
    );
  }

  const identity = identityOf(stats);
  if (expectedIdentity !== undefined && !sameIdentity(identity, expectedIdentity)) {
    throw new RealEvalSnapshotBoundaryError(
      'INTEGRITY_FAILED',
      'A verified snapshot entry was replaced',
    );
  }

  const canonicalPath = await realpath(path);
  throwIfAborted(signal);
  if (!samePath(canonicalPath, path)) {
    throw new RealEvalSnapshotBoundaryError(
      'BOUNDARY_VIOLATION',
      'The snapshot entry resolves through a different path',
    );
  }
  return identity;
}

async function readRegularFile(
  path: string,
  expectedIdentity?: FileIdentity,
  checkReparsePoint = true,
  signal?: AbortSignal,
): Promise<{ readonly contents: Buffer; readonly identity: FileIdentity }> {
  throwIfAborted(signal);
  const pathIdentity = await inspectEntry(
    path,
    'file',
    expectedIdentity,
    checkReparsePoint,
    signal,
  );
  const handle = await open(path, 'r');
  try {
    throwIfAborted(signal);
    const openedStats = await handle.stat({ bigint: true });
    const openedIdentity = identityOf(openedStats);
    if (
      !openedStats.isFile() ||
      !sameIdentity(openedIdentity, pathIdentity) ||
      (expectedIdentity !== undefined && !sameIdentity(openedIdentity, expectedIdentity))
    ) {
      throw new RealEvalSnapshotBoundaryError(
        'INTEGRITY_FAILED',
        'The opened file does not match the verified snapshot entry',
      );
    }
    if (openedStats.size > BigInt(maxSourceFileBytes)) {
      throw new RealEvalSnapshotBoundaryError(
        'SOURCE_INVALID',
        'The snapshot file exceeds the read limit',
      );
    }

    const buffer = Buffer.alloc(maxSourceFileBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maxSourceFileBytes) {
      throw new RealEvalSnapshotBoundaryError(
        'SOURCE_INVALID',
        'The snapshot file exceeds the read limit',
      );
    }

    const finalStats = await handle.stat({ bigint: true });
    const finalIdentity = identityOf(finalStats);
    if (!sameIdentity(finalIdentity, openedIdentity) || finalStats.size !== BigInt(offset)) {
      throw new RealEvalSnapshotBoundaryError(
        'INTEGRITY_FAILED',
        'The snapshot file changed while it was being read',
      );
    }
    const finalPathIdentity = await inspectEntry(
      path,
      'file',
      expectedIdentity ?? pathIdentity,
      checkReparsePoint,
      signal,
    );
    if (!sameIdentity(finalPathIdentity, openedIdentity)) {
      throw new RealEvalSnapshotBoundaryError(
        'INTEGRITY_FAILED',
        'The snapshot path no longer refers to the opened file',
      );
    }
    return { contents: Buffer.from(buffer.subarray(0, offset)), identity: openedIdentity };
  } finally {
    await handle.close();
  }
}

function identityPayload(
  manifest: Pick<RealEvalSnapshotManifest, 'baseRevision' | 'workingTreeDiffSha256' | 'files'>,
) {
  return {
    baseRevision: manifest.baseRevision,
    workingTreeDiffSha256: manifest.workingTreeDiffSha256,
    files: manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
}

export function computeRealEvalSnapshotId(
  manifest: Pick<RealEvalSnapshotManifest, 'baseRevision' | 'workingTreeDiffSha256' | 'files'>,
): string {
  return digest(JSON.stringify(identityPayload(manifest)));
}

export function computeRealEvalWorkingTreeDiffSha256(
  files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly origin: RealEvalSourceOrigin;
  }[],
): string {
  return digest(
    JSON.stringify(
      files.map(({ path, sha256, origin }) => ({
        path,
        sha256,
        gitStatus: origin.gitStatus,
        baseSha256: origin.baseSha256,
        diffSha256: origin.diffSha256,
      })),
    ),
  );
}

async function readSourceFile(repositoryRoot: string, path: string): Promise<Buffer> {
  const absolutePath = resolve(repositoryRoot, ...path.split('/'));
  if (!isInside(repositoryRoot, absolutePath)) {
    throw new RealEvalSnapshotBoundaryError('BOUNDARY_VIOLATION', 'Source path escaped root');
  }

  const segments = path.split('/');
  let current = repositoryRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    await inspectEntry(current, 'directory');
  }
  const read = await readRegularFile(absolutePath);
  return read.contents;
}

export async function createRealEvalSnapshot(
  options: CreateRealEvalSnapshotOptions,
): Promise<RealEvalSnapshot> {
  const repositoryRoot = await realpath(options.repositoryRoot);
  const snapshotsDirectory = resolve(options.snapshotsDirectory);
  await inspectEntry(snapshotsDirectory, 'directory');

  const revision = z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .safeParse(options.baseRevision);
  const diffHash = sha256Schema.safeParse(options.workingTreeDiffSha256);
  const createdAt = options.createdAt ?? new Date();
  if (
    !revision.success ||
    !diffHash.success ||
    !Number.isFinite(createdAt.getTime()) ||
    options.origins.size !== realEvalSourcePaths.length ||
    realEvalSourcePaths.some((path) => !options.origins.has(path))
  ) {
    throw new RealEvalSnapshotError('INVALID_MANIFEST', 'Snapshot provenance is invalid');
  }

  const sourceContents = await Promise.all(
    realEvalSourcePaths.map(async (path) => ({
      path,
      contents: await readSourceFile(repositoryRoot, path),
    })),
  );
  const files = sourceContents.map(({ path, contents }) => {
    const origin = options.origins.get(path);
    const parsedOrigin = sourceOriginSchema.safeParse(origin);
    if (!parsedOrigin.success) {
      throw new RealEvalSnapshotError('INVALID_MANIFEST', 'A source origin record is invalid');
    }
    return {
      path,
      bytes: contents.byteLength,
      sha256: digest(contents),
      origin: parsedOrigin.data,
    };
  });

  const manifestWithoutId = {
    schemaVersion: 1 as const,
    snapshotId: '0'.repeat(64),
    baseRevision: revision.data,
    workingTreeDiffSha256: diffHash.data,
    createdAt: createdAt.toISOString(),
    files,
  };
  const manifest = realEvalSnapshotManifestSchema.parse({
    ...manifestWithoutId,
    snapshotId: computeRealEvalSnapshotId(manifestWithoutId),
  });
  const snapshotRoot = join(snapshotsDirectory, manifest.snapshotId);
  const manifestPath = join(snapshotsDirectory, `${manifest.snapshotId}.manifest.json`);
  try {
    await lstat(snapshotRoot);
    throw new RealEvalSnapshotError('SNAPSHOT_EXISTS', 'The snapshot destination already exists');
  } catch (error) {
    if (error instanceof RealEvalSnapshotError) {
      throw error;
    }
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RealEvalSnapshotError('SNAPSHOT_READ_FAILED', 'The snapshot target is unavailable');
    }
  }
  try {
    await lstat(manifestPath);
    throw new RealEvalSnapshotError('SNAPSHOT_EXISTS', 'The snapshot manifest already exists');
  } catch (error) {
    if (error instanceof RealEvalSnapshotError) {
      throw error;
    }
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RealEvalSnapshotError('SNAPSHOT_READ_FAILED', 'The manifest target is unavailable');
    }
  }

  let snapshotCreated = false;
  try {
    await mkdir(snapshotRoot);
    snapshotCreated = true;
    for (const { path, contents } of sourceContents) {
      const destination = join(snapshotRoot, ...path.split('/'));
      await mkdir(join(destination, '..'), { recursive: true });
      await open(destination, 'wx', 0o444).then(async (handle) => {
        try {
          await handle.writeFile(contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    }
    await open(manifestPath, 'wx', 0o444).then(async (handle) => {
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  } catch (error) {
    await rm(manifestPath, { force: true }).catch(() => undefined);
    if (snapshotCreated) {
      await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof RealEvalSnapshotError) {
      throw error;
    }
    throw new RealEvalSnapshotError(
      'SNAPSHOT_READ_FAILED',
      'The source snapshot could not be written',
    );
  }

  const verified = await verifyRealEvalSnapshot(snapshotRoot, manifest);
  const snapshot = Object.freeze({ ...verified, manifestPath });
  const capability = snapshotCapabilities.get(verified);
  if (capability === undefined) {
    throw new RealEvalSnapshotError(
      'SNAPSHOT_READ_FAILED',
      'Snapshot verification lost its capability',
    );
  }
  snapshotCapabilities.delete(verified);
  snapshotCapabilities.set(snapshot, capability);
  return snapshot;
}

async function inspectSnapshotTree(
  rootDirectory: string,
  manifest: RealEvalSnapshotManifest,
  expectedDirectories?: ReadonlyMap<string, FileIdentity>,
  expectedFiles?: SnapshotCapability['files'],
  checkReparsePoints = true,
  signal?: AbortSignal,
): Promise<{ readonly directories: Map<string, FileIdentity>; readonly files: string[] }> {
  const directories = new Map<string, FileIdentity>();
  const files: string[] = [];

  async function inspectDirectory(directory: string, relativeDirectory: string): Promise<void> {
    if (!allowedDirectories.has(relativeDirectory)) {
      throw new RealEvalSnapshotBoundaryError(
        'BOUNDARY_VIOLATION',
        'The snapshot contains an unexpected directory',
      );
    }
    const identity = await inspectEntry(
      directory,
      'directory',
      expectedDirectories?.get(relativeDirectory),
      checkReparsePoints,
      signal,
    );
    directories.set(relativeDirectory, identity);

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (allowedDirectories.has(relativePath)) {
        await inspectDirectory(absolutePath, relativePath);
      } else if (allowedFiles.has(relativePath)) {
        await inspectEntry(
          absolutePath,
          'file',
          expectedFiles?.get(relativePath)?.identity,
          checkReparsePoints,
          signal,
        );
        files.push(relativePath);
      } else {
        throw new RealEvalSnapshotBoundaryError(
          'BOUNDARY_VIOLATION',
          'The snapshot contains an unexpected entry',
        );
      }
    }
  }

  await inspectDirectory(rootDirectory, '');
  const expectedPaths = manifest.files.map(({ path }) => path);
  if (
    files.length !== expectedPaths.length ||
    expectedPaths.some((path) => !files.includes(path))
  ) {
    throw new RealEvalSnapshotBoundaryError(
      'BOUNDARY_VIOLATION',
      'The snapshot file set does not match its manifest',
    );
  }
  return { directories, files };
}

export async function verifyRealEvalSnapshot(
  snapshotRootDirectory: string,
  manifestValue: unknown,
  manifestPath = '',
): Promise<RealEvalSnapshot> {
  const parsed = realEvalSnapshotManifestSchema.safeParse(manifestValue);
  if (!parsed.success) {
    throw new RealEvalSnapshotError('INVALID_MANIFEST', 'The snapshot manifest is invalid');
  }

  try {
    const rootDirectory = resolve(snapshotRootDirectory);
    const tree = await inspectSnapshotTree(rootDirectory, parsed.data);
    const files = new Map<string, { readonly identity: FileIdentity; readonly sha256: string }>();
    for (const file of parsed.data.files) {
      const actual = await readRegularFile(join(rootDirectory, ...file.path.split('/')));
      if (actual.contents.byteLength !== file.bytes || digest(actual.contents) !== file.sha256) {
        throw new RealEvalSnapshotBoundaryError(
          'INTEGRITY_FAILED',
          'A snapshot file does not match its frozen hash',
        );
      }
      files.set(file.path, { identity: actual.identity, sha256: file.sha256 });
    }
    const verifiedTree = await inspectSnapshotTree(
      rootDirectory,
      parsed.data,
      tree.directories,
      files,
      false,
    );
    const snapshot: RealEvalSnapshot = Object.freeze({
      rootDirectory,
      manifestPath,
      manifest: parsed.data,
    });
    snapshotCapabilities.set(snapshot, {
      directories: verifiedTree.directories,
      files,
    });
    return snapshot;
  } catch (error) {
    if (error instanceof RealEvalSnapshotError) {
      throw error;
    }
    if (error instanceof RealEvalSnapshotBoundaryError) {
      throw new RealEvalSnapshotError(
        error.code === 'BOUNDARY_VIOLATION' ? 'BOUNDARY_VIOLATION' : 'SNAPSHOT_READ_FAILED',
        error.message,
      );
    }
    throw new RealEvalSnapshotError('SNAPSHOT_READ_FAILED', 'The snapshot could not be verified');
  }
}

export async function readRealEvalSnapshotFiles(
  snapshot: RealEvalSnapshot,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  const capability = snapshotCapabilities.get(snapshot);
  if (
    capability === undefined ||
    paths.length === 0 ||
    paths.some((path) => typeof path !== 'string' || !allowedFiles.has(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new RealEvalSnapshotError('INVALID_MANIFEST', 'The requested snapshot paths are invalid');
  }

  try {
    throwIfAborted(signal);
    await inspectSnapshotTree(
      snapshot.rootDirectory,
      snapshot.manifest,
      capability.directories,
      capability.files,
      true,
      signal,
    );

    const contents = new Map<string, Buffer>();
    for (const file of snapshot.manifest.files) {
      throwIfAborted(signal);
      const expected = capability.files.get(file.path);
      if (expected === undefined) {
        throw new RealEvalSnapshotBoundaryError(
          'INTEGRITY_FAILED',
          'The verified snapshot capability is incomplete',
        );
      }
      const actual = await readRegularFile(
        join(snapshot.rootDirectory, ...file.path.split('/')),
        expected.identity,
        true,
        signal,
      );
      if (
        actual.contents.byteLength !== file.bytes ||
        digest(actual.contents) !== expected.sha256
      ) {
        throw new RealEvalSnapshotBoundaryError(
          'INTEGRITY_FAILED',
          'A verified snapshot file has changed',
        );
      }
      if (paths.includes(file.path)) {
        contents.set(file.path, actual.contents);
      }
    }

    await inspectSnapshotTree(
      snapshot.rootDirectory,
      snapshot.manifest,
      capability.directories,
      capability.files,
      false,
      signal,
    );
    return contents;
  } catch (error) {
    if (error instanceof RealEvalSnapshotError) {
      throw error;
    }
    if (error instanceof RealEvalSnapshotBoundaryError) {
      const code =
        error.code === 'BOUNDARY_VIOLATION' ? 'BOUNDARY_VIOLATION' : 'SNAPSHOT_READ_FAILED';
      throw new RealEvalSnapshotError(code, error.message);
    }
    throw new RealEvalSnapshotError('SNAPSHOT_READ_FAILED', 'The snapshot read failed');
  }
}
