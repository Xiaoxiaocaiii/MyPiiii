import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createToolContext } from '../../src/core/tool-permissions.js';
import {
  pilotSourceMaxBytes,
  pilotSourcePaths,
  preparePilotWorkspace,
  readPilotSourceFile,
  verifyPilotWorkspace,
  type PilotWorkspace,
} from '../../src/eval/pilot-workspace.js';

const repository = process.cwd();
let workspace: PilotWorkspace;

beforeAll(async () => {
  workspace = await preparePilotWorkspace(repository);
});

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace.rootDirectory, { recursive: true, force: true });
  }
});

async function withWorkspace<T>(run: (fixture: PilotWorkspace) => Promise<T>): Promise<T> {
  const fixture = await preparePilotWorkspace(repository);
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
}

describe('pilot source isolation', () => {
  it('copies only the hashed source snapshot outside the repository', async () => {
    expect(workspace.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(workspace.files.map((file) => file.path)).toEqual([...pilotSourcePaths]);
    const relativePath = relative(repository, workspace.rootDirectory);
    expect(isAbsolute(relativePath) || relativePath.startsWith('..')).toBe(true);
    expect(await verifyPilotWorkspace(repository, workspace.rootDirectory)).toEqual(workspace);
    await expect(
      access(join(workspace.rootDirectory, 'docs', 'research', '03-first-real-task-card.md')),
    ).rejects.toThrow();
  });

  it('denies path traversal through the workspace capability', () => {
    const context = createToolContext({
      scenarioId: 'repo-qa',
      workspaceRoot: workspace.rootDirectory,
      signal: new AbortController().signal,
    });
    expect(() => context.workspace?.resolvePath('../outside.txt')).toThrow();
    expect(() => context.workspace?.resolvePath(join(repository, 'docs', 'research'))).toThrow();
  });

  it('rejects modified or unexpected content before an evaluation run', async () => {
    const source = join(workspace.rootDirectory, pilotSourcePaths[0] ?? '');
    const original = await readFile(source);
    try {
      await writeFile(source, 'modified fixture');
      await expect(verifyPilotWorkspace(repository, workspace.rootDirectory)).rejects.toThrow(
        'does not match the repository snapshot',
      );
    } finally {
      await writeFile(source, original);
    }

    const extra = join(workspace.rootDirectory, 'answer.txt');
    try {
      await writeFile(extra, 'private scoring answer');
      await expect(verifyPilotWorkspace(repository, workspace.rootDirectory)).rejects.toThrow(
        'missing or unexpected files',
      );
    } finally {
      await rm(extra, { force: true });
    }

    const extraDirectory = join(workspace.rootDirectory, 'docs');
    try {
      await mkdir(extraDirectory);
      await expect(verifyPilotWorkspace(repository, workspace.rootDirectory)).rejects.toThrow(
        'unexpected directory',
      );
    } finally {
      await rm(extraDirectory, { recursive: true, force: true });
    }
  });

  it('reads only a verified allowlisted source file within the byte limit', async () => {
    await withWorkspace(async (fixture) => {
      const path = pilotSourcePaths[1]!;
      const contents = await readPilotSourceFile(fixture, path);

      expect(contents).toEqual(await readFile(join(fixture.rootDirectory, path)));
      expect(contents.length).toBeLessThanOrEqual(pilotSourceMaxBytes);
    });
  });

  it.each([
    ['absolute path', () => join(workspace.rootDirectory, pilotSourcePaths[0]!)],
    ['path traversal', () => '../outside.txt'],
    ['unapproved file', () => 'docs/research/03-first-real-task-card.md'],
  ])('denies %s', async (_name, path) => {
    await expect(readPilotSourceFile(workspace, path())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects a forged workspace object without a verified capability', async () => {
    const forged = { ...workspace };

    await expect(readPilotSourceFile(forged, pilotSourcePaths[0]!)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects content changed after workspace validation', async () => {
    await withWorkspace(async (fixture) => {
      const verified = await verifyPilotWorkspace(repository, fixture.rootDirectory);
      const path = pilotSourcePaths[0]!;
      await writeFile(join(verified.rootDirectory, path), 'changed after validation');

      await expect(readPilotSourceFile(verified, path)).rejects.toMatchObject({
        code: 'EXECUTION_FAILED',
      });
    });
  });

  it('rejects a replaced file even when replacement bytes match the pinned source', async () => {
    await withWorkspace(async (fixture) => {
      const verified = await verifyPilotWorkspace(repository, fixture.rootDirectory);
      const path = pilotSourcePaths[0]!;
      const source = join(verified.rootDirectory, path);
      const original = await readFile(source);
      const staging = await mkdtemp(join(tmpdir(), 'mypiiii-replacement-'));
      const replacement = join(staging, 'replacement.ts');
      const parkedOriginal = join(staging, 'original.ts');
      try {
        await writeFile(replacement, original);
        await rename(source, parkedOriginal);
        await rename(replacement, source);
        await expect(readPilotSourceFile(verified, path)).rejects.toMatchObject({
          code: 'EXECUTION_FAILED',
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  });

  it('rejects a directory junction or symbolic link in the source tree', async () => {
    await withWorkspace(async (fixture) => {
      const coreDirectory = join(fixture.rootDirectory, 'src', 'core');
      const targetDirectory = await mkdtemp(join(tmpdir(), 'mypiiii-link-target-'));
      try {
        await rm(coreDirectory, { recursive: true, force: true });
        await symlink(
          targetDirectory,
          coreDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(readPilotSourceFile(fixture, pilotSourcePaths[0]!)).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        await expect(verifyPilotWorkspace(repository, fixture.rootDirectory)).rejects.toThrow();
      } finally {
        await rm(coreDirectory, { recursive: true, force: true });
        await rm(targetDirectory, { recursive: true, force: true });
      }
    });
  });

  it('rejects unexpected files added after validation', async () => {
    await withWorkspace(async (fixture) => {
      const verified = await verifyPilotWorkspace(repository, fixture.rootDirectory);
      await writeFile(join(verified.rootDirectory, 'answer.txt'), 'not part of the snapshot');

      await expect(readPilotSourceFile(verified, pilotSourcePaths[0]!)).rejects.toMatchObject({
        code: 'EXECUTION_FAILED',
      });
    });
  });

  it('rejects a workspace file larger than the single-read cap', async () => {
    await withWorkspace(async (fixture) => {
      const path = pilotSourcePaths[0]!;
      await writeFile(
        join(fixture.rootDirectory, path),
        Buffer.alloc(pilotSourceMaxBytes + 1, 0x61),
      );

      await expect(readPilotSourceFile(fixture, path)).rejects.toMatchObject({
        name: 'ToolError',
        code: 'EXECUTION_FAILED',
      });
    });
  });
});
