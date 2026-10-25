import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { ToolError } from '../core/tool.js';

const runFile = promisify(execFile);

export const pilotSourceMaxBytes = 64 * 1024;
export const pilotSourcePaths = Object.freeze([
  'src/core/config.ts',
  'src/core/context-window.ts',
  'src/core/contracts.ts',
  'src/core/model.ts',
  'src/core/runtime.ts',
]);

export interface PilotWorkspace {
  readonly rootDirectory: string;
  readonly revision: string;
  readonly files: readonly { path: string; sha256: string }[];
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface PilotWorkspaceCapability {
  readonly directories: ReadonlyMap<string, FileIdentity>;
  readonly files: ReadonlyMap<
    string,
    { readonly identity: FileIdentity; readonly size: number; readonly sha256: string }
  >;
}

class PilotWorkspaceBoundaryError extends Error {
  constructor(
    readonly code: 'PERMISSION_DENIED' | 'EXECUTION_FAILED',
    message: string,
  ) {
    super(message);
  }
}

const workspaceCapabilities = new WeakMap<PilotWorkspace, PilotWorkspaceCapability>();
const allowedDirectories = new Set(['', 'src', 'src/core']);
const allowedFiles = new Set<string>(pilotSourcePaths);

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
    throw new PilotWorkspaceBoundaryError(
      'EXECUTION_FAILED',
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
    throw new PilotWorkspaceBoundaryError('EXECUTION_FAILED', 'The workspace read was aborted');
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
    // Windows ERROR_NOT_A_REPARSE_POINT; any other result is treated as unsafe.
    if (commandError.code === 1 && String(commandError.stdout).includes('4390')) {
      return;
    }
    if (commandError.code === 0) {
      throw new PilotWorkspaceBoundaryError('PERMISSION_DENIED', 'Reparse points are not allowed');
    }
    throw new PilotWorkspaceBoundaryError(
      'PERMISSION_DENIED',
      'Unable to verify the Windows reparse-point state',
    );
  }

  throwIfAborted(signal);
  throw new PilotWorkspaceBoundaryError('PERMISSION_DENIED', 'Reparse points are not allowed');
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
    throw new PilotWorkspaceBoundaryError(
      'PERMISSION_DENIED',
      'The workspace contains an unexpected file-system entry',
    );
  }

  const identity = identityOf(stats);
  if (expectedIdentity !== undefined && !sameIdentity(identity, expectedIdentity)) {
    throw new PilotWorkspaceBoundaryError(
      'EXECUTION_FAILED',
      'A verified workspace entry was replaced',
    );
  }

  const canonicalPath = await realpath(path);
  throwIfAborted(signal);
  if (!samePath(canonicalPath, path)) {
    throw new PilotWorkspaceBoundaryError(
      'PERMISSION_DENIED',
      'The workspace entry resolves through a different path',
    );
  }
  return identity;
}

async function readRegularFile(
  path: string,
  expectedIdentity?: FileIdentity,
  reparsePointAlreadyChecked = false,
  signal?: AbortSignal,
): Promise<{ readonly contents: Buffer; readonly identity: FileIdentity }> {
  throwIfAborted(signal);
  const pathIdentity = await inspectEntry(
    path,
    'file',
    expectedIdentity,
    !reparsePointAlreadyChecked,
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
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'The opened file does not match the verified workspace entry',
      );
    }
    if (openedStats.size > BigInt(pilotSourceMaxBytes)) {
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'The workspace file exceeds the read limit',
      );
    }

    const buffer = Buffer.alloc(pilotSourceMaxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > pilotSourceMaxBytes) {
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'The workspace file exceeds the read limit',
      );
    }

    const finalStats = await handle.stat({ bigint: true });
    const finalIdentity = identityOf(finalStats);
    if (!sameIdentity(finalIdentity, openedIdentity) || finalStats.size !== BigInt(offset)) {
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'The workspace file changed while it was being read',
      );
    }
    const finalPathIdentity = await inspectEntry(
      path,
      'file',
      expectedIdentity ?? pathIdentity,
      !reparsePointAlreadyChecked,
      signal,
    );
    if (!sameIdentity(finalPathIdentity, openedIdentity)) {
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'The workspace path no longer refers to the opened file',
      );
    }

    return {
      contents: Buffer.from(buffer.subarray(0, offset)),
      identity: openedIdentity,
    };
  } finally {
    await handle.close();
  }
}

async function inspectWorkspaceTree(
  rootDirectory: string,
  expectedDirectories?: ReadonlyMap<string, FileIdentity>,
  expectedFiles?: PilotWorkspaceCapability['files'],
  checkReparsePoints = true,
  signal?: AbortSignal,
): Promise<{ readonly directories: Map<string, FileIdentity>; readonly files: string[] }> {
  const directories = new Map<string, FileIdentity>();
  const files: string[] = [];

  async function inspectDirectory(directory: string, relativeDirectory: string): Promise<void> {
    if (!allowedDirectories.has(relativeDirectory)) {
      throw new Error(`Pilot workspace contains an unexpected directory: ${relativeDirectory}`);
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
      } else if (entry.isDirectory()) {
        throw new Error(`Pilot workspace contains an unexpected directory: ${relativePath}`);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Pilot workspace contains a non-regular entry: ${relativePath}`);
      }
    }
  }

  await inspectDirectory(rootDirectory, '');
  if (files.length !== pilotSourcePaths.length) {
    throw new Error('Pilot workspace contains missing or unexpected files');
  }
  return { directories, files };
}

async function readRepositorySource(repositoryRoot: string, path: string): Promise<Buffer> {
  let currentDirectory = repositoryRoot;
  for (const segment of path.split('/').slice(0, -1)) {
    currentDirectory = join(currentDirectory, segment);
    await inspectEntry(currentDirectory, 'directory');
  }
  return (await readRegularFile(join(repositoryRoot, ...path.split('/')))).contents;
}

function digest(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function revisionForSources(sources: readonly { path: string; contents: Buffer }[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(sources.map(({ path, contents }) => ({ path, sha256: digest(contents) }))),
    )
    .digest('hex');
}

export async function preparePilotWorkspace(repositoryRoot: string): Promise<PilotWorkspace> {
  const repository = await realpath(repositoryRoot);
  const temporaryRoot = await realpath(tmpdir());
  if (isInside(repository, temporaryRoot)) {
    throw new Error('The pilot workspace must be outside the repository');
  }

  const sources = await Promise.all(
    pilotSourcePaths.map(async (path) => ({
      path,
      contents: await readRepositorySource(repository, path),
    })),
  );
  for (const { path, contents } of sources) {
    if (contents.length > pilotSourceMaxBytes) {
      throw new Error(`Pilot source exceeds the read limit: ${path}`);
    }
  }
  const rootDirectory = await mkdtemp(join(temporaryRoot, 'mypiiii-pilot-'));
  try {
    await mkdir(join(rootDirectory, 'src', 'core'), { recursive: true });
    for (const { path, contents } of sources) {
      await writeFile(join(rootDirectory, path), contents, { flag: 'wx' });
    }
    return await verifyPilotWorkspace(repository, rootDirectory);
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPilotWorkspace(
  repositoryRoot: string,
  workspaceRoot: string,
): Promise<PilotWorkspace> {
  const repository = await realpath(repositoryRoot);
  const requestedRoot = resolve(workspaceRoot);
  await inspectEntry(requestedRoot, 'directory');
  const rootDirectory = await realpath(requestedRoot);
  if (isInside(repository, rootDirectory) || rootDirectory === repository) {
    throw new Error('The pilot workspace must be outside the repository');
  }

  const tree = await inspectWorkspaceTree(rootDirectory);
  const found = new Set(tree.files);
  if (pilotSourcePaths.some((path) => !found.has(path))) {
    throw new Error('Pilot workspace contains missing or unexpected files');
  }

  let totalBytes = 0;
  const files: { path: string; sha256: string }[] = [];
  const fileIdentities = new Map<
    string,
    { readonly identity: FileIdentity; readonly size: number; readonly sha256: string }
  >();
  const expectedSources = new Map(
    (
      await Promise.all(
        pilotSourcePaths.map(async (path) => ({
          path,
          contents: await readRepositorySource(repository, path),
        })),
      )
    ).map((source) => [source.path, source.contents]),
  );
  for (const path of pilotSourcePaths) {
    const expected = expectedSources.get(path);
    if (expected === undefined) {
      throw new Error(`Pilot source is unavailable: ${path}`);
    }
    if (expected.length > pilotSourceMaxBytes) {
      throw new Error(`Pilot source exceeds the read limit: ${path}`);
    }
    const actual = await readRegularFile(resolve(rootDirectory, path), undefined, true);
    if (!actual.contents.equals(expected)) {
      throw new Error(`Pilot source does not match the repository snapshot: ${path}`);
    }
    totalBytes += actual.contents.length;
    const sha256 = digest(actual.contents);
    files.push({ path, sha256 });
    fileIdentities.set(path, {
      identity: actual.identity,
      size: actual.contents.length,
      sha256,
    });
  }
  if (totalBytes > pilotSourcePaths.length * pilotSourceMaxBytes) {
    throw new Error('Pilot workspace exceeds the total read limit');
  }
  await inspectWorkspaceTree(rootDirectory, tree.directories, fileIdentities, false);

  const workspace: PilotWorkspace = Object.freeze({
    rootDirectory,
    revision: revisionForSources(
      pilotSourcePaths.map((path) => ({
        path,
        contents: expectedSources.get(path)!,
      })),
    ),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
  workspaceCapabilities.set(workspace, {
    directories: tree.directories,
    files: fileIdentities,
  });
  return workspace;
}

export async function readPilotSourceFiles(
  workspace: PilotWorkspace,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  const capability = workspaceCapabilities.get(workspace);
  if (
    capability === undefined ||
    paths.length === 0 ||
    paths.some((path) => typeof path !== 'string' || !allowedFiles.has(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new ToolError('PERMISSION_DENIED');
  }

  try {
    throwIfAborted(signal);
    const tree = await inspectWorkspaceTree(
      workspace.rootDirectory,
      capability.directories,
      capability.files,
      true,
      signal,
    );
    const found = new Set(tree.files);
    if (pilotSourcePaths.some((sourcePath) => !found.has(sourcePath))) {
      throw new PilotWorkspaceBoundaryError(
        'EXECUTION_FAILED',
        'A verified workspace file is missing',
      );
    }

    const contents = new Map<string, Buffer>();
    for (const sourcePath of pilotSourcePaths) {
      throwIfAborted(signal);
      const expected = capability.files.get(sourcePath);
      if (expected === undefined) {
        throw new PilotWorkspaceBoundaryError(
          'EXECUTION_FAILED',
          'The workspace capability is incomplete',
        );
      }
      const actual = await readRegularFile(
        resolve(workspace.rootDirectory, sourcePath),
        expected.identity,
        true,
        signal,
      );
      if (actual.contents.length !== expected.size || digest(actual.contents) !== expected.sha256) {
        throw new PilotWorkspaceBoundaryError(
          'EXECUTION_FAILED',
          'A verified workspace file has changed',
        );
      }
      if (paths.includes(sourcePath)) {
        contents.set(sourcePath, actual.contents);
      }
    }

    await inspectWorkspaceTree(
      workspace.rootDirectory,
      capability.directories,
      capability.files,
      false,
      signal,
    );
    if (contents.size !== paths.length) {
      throw new PilotWorkspaceBoundaryError('EXECUTION_FAILED', 'A requested file is unavailable');
    }
    return contents;
  } catch (error) {
    if (error instanceof PilotWorkspaceBoundaryError) {
      throw new ToolError(error.code);
    }
    throw new ToolError('EXECUTION_FAILED');
  }
}

export async function readPilotSourceFile(
  workspace: PilotWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const contents = await readPilotSourceFiles(workspace, [path], signal);
  const file = contents.get(path);
  if (file === undefined) {
    throw new ToolError('EXECUTION_FAILED');
  }
  return file;
}
