import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ExperimentConfig } from '../../src/core/config.js';
import { FakeModelAdapter } from '../../src/core/fake-model.js';
import { createToolContext } from '../../src/core/tool-permissions.js';
import { runAgent, type RuntimeInput } from '../../src/core/runtime.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { executeToolCall, type ToolCallAction } from '../../src/core/tool-runtime.js';
import type { JsonValue, Observation } from '../../src/core/contracts.js';
import {
  computeRealEvalWorkingTreeDiffSha256,
  createRealEvalSnapshot,
  readRealEvalSnapshotFiles,
  realEvalSourcePaths,
  type RealEvalSnapshot,
} from '../../src/eval/real-eval-snapshot.js';
import {
  createRealEvalSnapshotPreflight,
  createRealEvalToolRegistry,
  realEvalToolNames,
} from '../../src/eval/real-eval-tools.js';

const sourceWithManyLines = Buffer.from(
  Array.from({ length: 80 }, (_, index) => `needle ${index} ${'x'.repeat(600)}`).join('\n'),
);

let temporaryRoot: string;
let repositoryRoot: string;
let snapshotsDirectory: string;
let snapshot: RealEvalSnapshot;
let registry: ToolRegistry;

const config: ExperimentConfig = {
  schemaVersion: 1,
  configId: 'real-eval-tools-test',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 1024,
  },
  runtime: { maxTurns: 2, timeoutMs: 30_000 },
  tools: { enabled: [...realEvalToolNames] },
  artifacts: { directory: './artifacts' },
};

function sourceContents(path: string): Buffer {
  return path === realEvalSourcePaths[0]
    ? sourceWithManyLines
    : Buffer.from(`// frozen fixture: ${path}\nexport const fixture = true;\n`, 'utf8');
}

async function makeSnapshot(): Promise<RealEvalSnapshot> {
  const origins = new Map(
    realEvalSourcePaths.map((path) => [
      path,
      { gitStatus: '??', baseSha256: null, diffSha256: null },
    ]),
  );
  for (const path of realEvalSourcePaths) {
    const filePath = join(repositoryRoot, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, sourceContents(path));
  }

  const workingTreeDiffSha256 = computeRealEvalWorkingTreeDiffSha256(
    realEvalSourcePaths.map((path) => ({
      path,
      sha256: createHash('sha256').update(sourceContents(path)).digest('hex'),
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

function makeAction(toolName: (typeof realEvalToolNames)[number], args: JsonValue): ToolCallAction {
  return {
    schemaVersion: 1,
    type: 'tool_call',
    callId: `call-${toolName}`,
    toolName,
    args,
  };
}

function invoke(
  toolName: (typeof realEvalToolNames)[number],
  args: JsonValue,
  activeRegistry = registry,
  signal = new AbortController().signal,
): Promise<Observation> {
  return executeToolCall(makeAction(toolName, args), activeRegistry, {
    context: createToolContext({ scenarioId: 'repo-qa', signal }),
    enabledTools: [...realEvalToolNames],
  });
}

function successfulResult(observation: Observation): Extract<Observation, { type: 'tool_result' }> {
  if (observation.type !== 'tool_result') {
    throw new Error(`Expected a successful tool result, got ${observation.type}`);
  }
  return observation;
}

async function setSnapshotFileWritable(path: string): Promise<void> {
  await chmod(path, 0o644);
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mypiiii-real-eval-tools-'));
  repositoryRoot = join(temporaryRoot, 'repository');
  snapshotsDirectory = join(temporaryRoot, 'snapshots');
  await mkdir(repositoryRoot);
  await mkdir(snapshotsDirectory);
  snapshot = await makeSnapshot();
  registry = createRealEvalToolRegistry(snapshot);
});

afterAll(async () => {
  if (snapshot !== undefined) {
    for (const path of realEvalSourcePaths) {
      await chmod(join(snapshot.rootDirectory, ...path.split('/')), 0o644).catch(() => undefined);
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('real-eval read-only tool registry', () => {
  it('registers only three read-only tools for repo-qa', () => {
    expect(
      registry.listAvailable('repo-qa', [...realEvalToolNames]).map(({ name }) => name),
    ).toEqual([...realEvalToolNames].sort((left, right) => left.localeCompare(right)));
    expect(registry.listAvailable('other-scenario', [...realEvalToolNames])).toEqual([]);
    for (const name of realEvalToolNames) {
      expect(registry.resolve(name, 'repo-qa', [...realEvalToolNames])).toMatchObject({
        name,
        schemaVersion: 1,
        sideEffect: 'none',
        allowedScenarios: ['repo-qa'],
        timeoutMs: 15_000,
      });
    }
  });

  it('lists exactly the frozen source allowlist, without research material', async () => {
    const result = successfulResult(await invoke('repo.list_files', {}));

    expect(result.data).toEqual({ files: [...realEvalSourcePaths] });
    expect(JSON.stringify(result.data)).not.toContain('rubrics');
    expect(JSON.stringify(result.data)).not.toContain('tasks');
    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('keeps visible tool descriptions aligned with executable tools and their schemas', () => {
    const descriptions = registry.describeAvailable('repo-qa', [...realEvalToolNames]);
    expect(descriptions.map(({ name }) => name)).toEqual(
      [...realEvalToolNames].sort((left, right) => left.localeCompare(right)),
    );
    for (const description of descriptions) {
      const definition = registry.resolve(description.name, 'repo-qa', [...realEvalToolNames]);
      expect(description.schemaVersion).toBe(definition.schemaVersion);
      expect(description.description).toBe(definition.description);
      expect(description.inputSchema).toEqual(z.toJSONSchema(definition.inputSchema));
    }
  });

  it.each([
    { path: '../outside.txt', startLine: 1, endLine: 2 },
    { path: 'docs/research/real-eval/rubrics/rubrics.json', startLine: 1, endLine: 2 },
    { path: 'docs/research/real-eval/tasks/task-001.md', startLine: 1, endLine: 2 },
    { path: 'C:\\outside.txt', startLine: 1, endLine: 2 },
    { path: realEvalSourcePaths[0], startLine: 1, endLine: 81 },
    { path: realEvalSourcePaths[0], startLine: 4, endLine: 3 },
  ])('rejects paths or ranges outside its schema %#', async (args) => {
    expect(await invoke('repo.read_file_lines', args)).toMatchObject({
      type: 'tool_error',
      code: 'INPUT_INVALID',
    });
  });
});

describe('repo.search_source', () => {
  it('searches frozen local bytes and returns 1-based path/line evidence', async () => {
    const result = successfulResult(await invoke('repo.search_source', { query: 'NEEDLE' }));
    const data = result.data as {
      matches: { path: string; line: number }[];
      truncated: boolean;
    };

    expect(data.matches[0]).toEqual(
      expect.objectContaining({ path: realEvalSourcePaths[0], line: 1 }),
    );
    expect(result.truncated).toBe(true);
  });

  it('bounds match count and serialized output, marking truncation', async () => {
    const result = successfulResult(await invoke('repo.search_source', { query: 'needle' }));
    const data = result.data as { matches: unknown[]; truncated: boolean };

    expect(data.matches).toHaveLength(20);
    expect(data.truncated).toBe(true);
    expect(data.matches.length).toBeLessThan(80);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('rejects empty search text', async () => {
    expect(await invoke('repo.search_source', { query: '   ' })).toMatchObject({
      type: 'tool_error',
      code: 'INPUT_INVALID',
    });
  });
});

describe('repo.read_file_lines', () => {
  it('reads the real frozen local source bytes with bounded lines and total output', async () => {
    const result = successfulResult(
      await invoke('repo.read_file_lines', {
        path: realEvalSourcePaths[0],
        startLine: 1,
        endLine: 80,
      }),
    );
    const data = result.data as {
      path: string;
      startLine: number;
      endLine: number;
      lines: { line: number; text: string }[];
      truncated: boolean;
    };

    expect(data.path).toBe(realEvalSourcePaths[0]);
    expect(data.lines[0]).toMatchObject({ line: 1 });
    expect(data.lines.every(({ text }) => Buffer.byteLength(text, 'utf8') <= 512)).toBe(true);
    expect(data.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('honors cancellation before reading and normalizes it as a tool error', async () => {
    const controller = new AbortController();
    controller.abort('private cancel reason');
    const observation = await invoke(
      'repo.read_file_lines',
      { path: realEvalSourcePaths[0], startLine: 1, endLine: 2 },
      registry,
      controller.signal,
    );

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
      retryable: true,
    });
    expect(JSON.stringify(observation)).not.toContain('private cancel reason');
  });

  it('honors cancellation during a source read', async () => {
    const controller = new AbortController();
    const operation = invoke(
      'repo.search_source',
      { query: 'needle' },
      registry,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort('private in-flight cancel reason');
    const observation = await operation;

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'EXECUTION_FAILED',
      retryable: true,
    });
    expect(JSON.stringify(observation)).not.toContain('private in-flight cancel reason');
  });

  it('detects changed bytes before returning any source output', async () => {
    const path = realEvalSourcePaths[0];
    const absolutePath = join(snapshot.rootDirectory, ...path.split('/'));
    const original = await readFile(absolutePath);
    try {
      await setSnapshotFileWritable(absolutePath);
      await writeFile(absolutePath, 'tampered snapshot');
      expect(
        await invoke('repo.read_file_lines', { path, startLine: 1, endLine: 2 }),
      ).toMatchObject({ type: 'tool_error', code: 'EXECUTION_FAILED' });
    } finally {
      await setSnapshotFileWritable(absolutePath);
      await writeFile(absolutePath, original);
      await chmod(absolutePath, 0o444);
    }
  });
});

describe('real-eval request preflight', () => {
  it('exposes the same allowlisted tools that the registry can execute', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: { schemaVersion: 1, type: 'final_answer', content: 'done' },
        },
      },
    ]);
    const input: RuntimeInput = {
      schemaVersion: 1,
      sessionId: 'real-eval-tool-description-test',
      inputMessage: 'Answer using the frozen source.',
      config,
    };
    const result = await runAgent(input, adapter, {
      tools: { registry },
      beforeModelRequest: createRealEvalSnapshotPreflight(snapshot),
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(adapter.requests[0]?.tools).toEqual(
      registry.describeAvailable('repo-qa', [...realEvalToolNames]),
    );
  });

  it('rejects injected scoring material before the model adapter is called', async () => {
    const injectedFile = join(snapshot.rootDirectory, 'rubrics.json');
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: { schemaVersion: 1, type: 'final_answer', content: 'must not be sent' },
        },
      },
    ]);
    const input: RuntimeInput = {
      schemaVersion: 1,
      sessionId: 'real-eval-preflight-test',
      inputMessage: 'Answer using the frozen source.',
      config,
    };

    await writeFile(injectedFile, '{"injected":"private scoring material"}');
    try {
      const result = await runAgent(input, adapter, {
        tools: { registry },
        beforeModelRequest: createRealEvalSnapshotPreflight(snapshot),
      });

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'MODEL_CALL_FAILED' },
      });
      expect(adapter.requests).toHaveLength(0);
    } finally {
      await rm(injectedFile, { force: true });
    }
  });

  it('aborts when the verified snapshot contains a linked directory', async () => {
    const coreDirectory = join(snapshot.rootDirectory, 'src', 'core');
    const parkedDirectory = join(temporaryRoot, 'parked-core');
    const targetDirectory = join(temporaryRoot, 'linked-core');
    await mkdir(targetDirectory);

    try {
      await rename(coreDirectory, parkedDirectory);
      await symlink(
        targetDirectory,
        coreDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(await invoke('repo.list_files', {})).toMatchObject({
        type: 'tool_error',
        code: 'EXECUTION_FAILED',
      });
    } finally {
      await rm(coreDirectory, { recursive: true, force: true });
      await rename(parkedDirectory, coreDirectory).catch(() => undefined);
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });
});

it('preserves tool timeout enforcement', async () => {
  const listDefinition = registry.resolve('repo.list_files', 'repo-qa', [...realEvalToolNames]);
  const slowRegistry = new ToolRegistry([
    {
      ...listDefinition,
      timeoutMs: 1,
      execute: () =>
        new Promise<{ files: (typeof realEvalSourcePaths)[number][] }>((resolve) => {
          setTimeout(() => resolve({ files: [...realEvalSourcePaths] }), 25);
        }),
    },
  ]);

  expect(await invoke('repo.list_files', {}, slowRegistry)).toMatchObject({
    type: 'tool_error',
    code: 'TIMEOUT',
  });
});

it('exposes no capability for a forged snapshot object', async () => {
  const forged = { ...snapshot };
  await expect(readRealEvalSnapshotFiles(forged, [realEvalSourcePaths[0]])).rejects.toMatchObject({
    code: 'INVALID_MANIFEST',
  });
});
