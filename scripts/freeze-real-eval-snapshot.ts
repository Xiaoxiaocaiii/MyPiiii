import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  computeRealEvalWorkingTreeDiffSha256,
  createRealEvalSnapshot,
  realEvalSourcePaths,
  type RealEvalSourceOrigin,
  verifyRealEvalSnapshot,
} from '../src/eval/real-eval-snapshot.js';

const repositoryRoot = resolve(process.cwd());
const snapshotsDirectory = join(repositoryRoot, 'docs', 'research', 'real-eval', 'snapshots');

function sha256(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function gitBuffer(args: readonly string[]): Buffer {
  return execFileSync('git', [...args], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

async function main(): Promise<void> {
  const [mode, requestedSnapshotId] = process.argv.slice(2);
  if (mode === '--verify') {
    if (requestedSnapshotId === undefined || !/^[a-f0-9]{64}$/.test(requestedSnapshotId)) {
      throw new Error('Usage: freeze-real-eval-snapshot.ts --verify <snapshotId>');
    }
    const manifestPath = join(snapshotsDirectory, `${requestedSnapshotId}.manifest.json`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    const snapshot = await verifyRealEvalSnapshot(
      join(snapshotsDirectory, requestedSnapshotId),
      manifest,
      manifestPath,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          verified: true,
          snapshotId: snapshot.manifest.snapshotId,
          fileCount: snapshot.manifest.files.length,
          files: snapshot.manifest.files.map(({ path, bytes, sha256 }) => ({
            path,
            bytes,
            sha256,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (mode !== undefined || requestedSnapshotId !== undefined) {
    throw new Error('Only --verify <snapshotId> is supported');
  }

  const baseRevision = gitBuffer(['rev-parse', 'HEAD']).toString('utf8').trim();
  const origins = new Map<string, RealEvalSourceOrigin>();
  const currentFiles: Array<{ readonly path: string; readonly sha256: string }> = [];

  for (const path of realEvalSourcePaths) {
    const currentBytes = await readFile(join(repositoryRoot, ...path.split('/')));
    const statusOutput = gitBuffer([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      path,
    ]).toString('utf8');
    const gitStatus = statusOutput.length === 0 ? '  ' : statusOutput.slice(0, 2);
    const trackedPath =
      gitBuffer(['ls-tree', '--name-only', baseRevision, '--', path]).toString('utf8').trim() ===
      path;
    const baseBytes = trackedPath ? gitBuffer(['show', `${baseRevision}:${path}`]) : null;
    const diffBytes = trackedPath
      ? gitBuffer(['diff', '--binary', '--no-ext-diff', baseRevision, '--', path])
      : null;
    const origin: RealEvalSourceOrigin = {
      gitStatus,
      baseSha256: baseBytes === null ? null : sha256(baseBytes),
      diffSha256: diffBytes === null || diffBytes.byteLength === 0 ? null : sha256(diffBytes),
    };
    origins.set(path, origin);
    currentFiles.push({ path, sha256: sha256(currentBytes) });
  }

  const provenanceFiles = realEvalSourcePaths.map((path, index) => ({
    path,
    sha256: currentFiles[index]!.sha256,
    origin: origins.get(path)!,
  }));
  const workingTreeDiffSha256 = computeRealEvalWorkingTreeDiffSha256(provenanceFiles);
  const snapshot = await createRealEvalSnapshot({
    repositoryRoot,
    snapshotsDirectory,
    baseRevision,
    workingTreeDiffSha256,
    origins,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        snapshotId: snapshot.manifest.snapshotId,
        baseRevision: snapshot.manifest.baseRevision,
        workingTreeDiffSha256: snapshot.manifest.workingTreeDiffSha256,
        fileCount: snapshot.manifest.files.length,
        manifestPath: snapshot.manifestPath,
        rootDirectory: snapshot.rootDirectory,
        files: snapshot.manifest.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          gitStatus: file.origin.gitStatus,
          baseSha256: file.origin.baseSha256,
          diffSha256: file.origin.diffSha256,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

await main();
