import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeRealEvalWorkingTreeDiffSha256,
  createRealEvalSnapshot,
  readRealEvalSnapshotFiles,
  realEvalSourcePaths,
  verifyRealEvalSnapshot,
  type RealEvalSnapshot,
} from '../../src/eval/real-eval-snapshot.js';

const sha256 = (contents: Uint8Array | string): string =>
  createHash('sha256').update(contents).digest('hex');

let temporaryRoot: string;
let repositoryRoot: string;
let snapshotsDirectory: string;
let snapshot: RealEvalSnapshot;
let fixtureFiles: Map<string, Buffer>;

async function createFixture(): Promise<RealEvalSnapshot> {
  fixtureFiles = new Map();
  const origins = new Map<
    string,
    {
      readonly gitStatus: string;
      readonly baseSha256: string | null;
      readonly diffSha256: string | null;
    }
  >();

  for (const path of realEvalSourcePaths) {
    const contents = Buffer.from(`// frozen fixture for ${path}\n`, 'utf8');
    fixtureFiles.set(path, contents);
    const filePath = join(repositoryRoot, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    origins.set(path, { gitStatus: '??', baseSha256: null, diffSha256: null });
  }

  const workingTreeDiffSha256 = computeRealEvalWorkingTreeDiffSha256(
    realEvalSourcePaths.map((path) => ({
      path,
      sha256: sha256(fixtureFiles.get(path)!),
      origin: origins.get(path)!,
    })),
  );
  return createRealEvalSnapshot({
    repositoryRoot,
    snapshotsDirectory,
    baseRevision: 'a'.repeat(40),
    workingTreeDiffSha256,
    origins,
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
  });
}

async function setSnapshotWritable(path: string): Promise<void> {
  await chmod(path, 0o644);
}

async function restoreSnapshotFile(path: string, contents: Buffer): Promise<void> {
  await setSnapshotWritable(path);
  await writeFile(path, contents);
  await chmod(path, 0o444);
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mypiiii-real-eval-snapshot-'));
  repositoryRoot = join(temporaryRoot, 'repository');
  snapshotsDirectory = join(temporaryRoot, 'snapshots');
  await mkdir(repositoryRoot);
  await mkdir(snapshotsDirectory);
  snapshot = await createFixture();
});

afterAll(async () => {
  if (snapshot !== undefined) {
    for (const path of realEvalSourcePaths) {
      await chmod(join(snapshot.rootDirectory, ...path.split('/')), 0o644).catch(() => undefined);
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('real evaluation source snapshot', () => {
  it('freezes exactly the allowlisted source bytes and verifies their hashes', async () => {
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual([...realEvalSourcePaths]);
    expect(snapshot.manifestPath).toContain(`${snapshot.manifest.snapshotId}.manifest.json`);
    expect(snapshot.rootDirectory).toContain(snapshot.manifest.snapshotId);
    expect(snapshot.manifest.files.every((file) => file.origin.gitStatus === '??')).toBe(true);
    expect(
      await readFile(join(snapshot.rootDirectory, ...realEvalSourcePaths[0].split('/'))),
    ).toEqual(fixtureFiles.get(realEvalSourcePaths[0]));

    const verified = await verifyRealEvalSnapshot(
      snapshot.rootDirectory,
      snapshot.manifest,
      snapshot.manifestPath,
    );
    const contents = await readRealEvalSnapshotFiles(verified, [realEvalSourcePaths[0]]);
    expect(contents.get(realEvalSourcePaths[0])).toEqual(fixtureFiles.get(realEvalSourcePaths[0]));
  });

  it('does not overwrite an existing snapshot identity', async () => {
    await expect(createFixture()).rejects.toMatchObject({ code: 'SNAPSHOT_EXISTS' });
  });

  it('denies traversal, unlisted paths, and forged capabilities', async () => {
    await expect(readRealEvalSnapshotFiles(snapshot, ['../answer.txt'])).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
    await expect(
      readRealEvalSnapshotFiles(snapshot, ['docs/research/real-eval/rubrics/answer.json']),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(
      readRealEvalSnapshotFiles({ ...snapshot }, [realEvalSourcePaths[0]]),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('rejects changed bytes and detects the change on subsequent reads', async () => {
    const path = realEvalSourcePaths[0];
    const absolutePath = join(snapshot.rootDirectory, ...path.split('/'));
    const original = fixtureFiles.get(path)!;
    try {
      await setSnapshotWritable(absolutePath);
      await writeFile(absolutePath, 'tampered');
      await expect(
        verifyRealEvalSnapshot(snapshot.rootDirectory, snapshot.manifest),
      ).rejects.toThrow();
      await expect(readRealEvalSnapshotFiles(snapshot, [path])).rejects.toMatchObject({
        code: 'SNAPSHOT_READ_FAILED',
      });
    } finally {
      await restoreSnapshotFile(absolutePath, original);
    }
  });

  it('rejects replacement with identical bytes by file identity', async () => {
    const path = realEvalSourcePaths[0];
    const absolutePath = join(snapshot.rootDirectory, ...path.split('/'));
    const original = fixtureFiles.get(path)!;
    const staging = join(temporaryRoot, 'replacement');
    const parkedOriginal = join(staging, 'original.ts');
    const replacement = join(staging, 'replacement.ts');
    await mkdir(staging);
    try {
      await setSnapshotWritable(absolutePath);
      await writeFile(replacement, original);
      await rename(absolutePath, parkedOriginal);
      await rename(replacement, absolutePath);
      await expect(readRealEvalSnapshotFiles(snapshot, [path])).rejects.toMatchObject({
        code: 'SNAPSHOT_READ_FAILED',
      });
    } finally {
      await rm(absolutePath, { force: true });
      await rename(parkedOriginal, absolutePath).catch(() => undefined);
      await chmod(absolutePath, 0o444).catch(() => undefined);
      await rm(staging, { recursive: true, force: true });
    }
  });

  it('rejects extra files and symbolic-link directories', async () => {
    const extraFile = join(snapshot.rootDirectory, 'answer.txt');
    await writeFile(extraFile, 'must not enter the snapshot');
    await expect(
      readRealEvalSnapshotFiles(snapshot, [realEvalSourcePaths[0]]),
    ).rejects.toMatchObject({
      code: 'BOUNDARY_VIOLATION',
    });
    await rm(extraFile);

    const coreDirectory = join(snapshot.rootDirectory, 'src', 'core');
    const parkedDirectory = join(temporaryRoot, 'parked-core');
    const targetDirectory = join(temporaryRoot, 'link-target');
    await mkdir(targetDirectory);
    try {
      await rename(coreDirectory, parkedDirectory);
      await symlink(
        targetDirectory,
        coreDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        readRealEvalSnapshotFiles(snapshot, [realEvalSourcePaths[0]]),
      ).rejects.toMatchObject({
        code: 'BOUNDARY_VIOLATION',
      });
    } finally {
      await rm(coreDirectory, { recursive: true, force: true });
      await rename(parkedDirectory, coreDirectory).catch(() => undefined);
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });
});
