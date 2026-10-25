import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PilotTaskError, runPilotTaskCommand } from '../../src/eval/pilot-task.js';
import { preparePilotWorkspace } from '../../src/eval/pilot-workspace.js';
import { createSqliteRunIndex } from '../../src/observability/sqlite-run-index.js';
import { analyzeTraceConsistency } from '../../src/observability/trace-consistency.js';
import { loadTraceRun, type TraceIntegrityError } from '../../src/observability/trace-loader.js';
import { replayLoadedTrace } from '../../src/observability/trace-replay.js';

const acceptedArgs = ['--confirm-paid-call'];
const temporaryDirectories: string[] = [];

function response(output: unknown): Response {
  return Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: JSON.stringify(output) },
      },
    ],
  });
}

describe('pilot task CLI command', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function temporaryArtifactDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mypiiii-pilot-artifacts-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  function expectContextRequestsAligned(
    events: Awaited<ReturnType<typeof loadTraceRun>>['events'],
  ): void {
    const contexts = events.filter((event) => event.eventType === 'context.built');
    const requests = events.filter((event) => event.eventType === 'model.requested');
    expect(contexts).toHaveLength(requests.length);
    expect(contexts.map((event) => event.payload.context)).toEqual(
      requests.map((event) => event.payload.request.context),
    );
  }

  it('reports a missing key before preparing a workspace or making a request', async () => {
    const prepareWorkspace = vi.fn<typeof preparePilotWorkspace>();
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      runPilotTaskCommand(acceptedArgs, () => undefined, {
        env: {},
        prepareWorkspace,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      name: 'PilotTaskError',
      code: 'DEEPSEEK_API_KEY_MISSING',
      message: 'Set DEEPSEEK_API_KEY to run the DeepSeek pilot task',
    });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires explicit cost confirmation before preparing the snapshot', async () => {
    const prepareWorkspace = vi.fn<typeof preparePilotWorkspace>();
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      runPilotTaskCommand([], () => undefined, {
        env: { DEEPSEEK_API_KEY: 'offline-secret' },
        prepareWorkspace,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: 'PAID_CALL_CONFIRMATION_REQUIRED',
    });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicitly selected DeepSeek model ID', async () => {
    const prepareWorkspace = vi.fn<typeof preparePilotWorkspace>();
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      runPilotTaskCommand(acceptedArgs, () => undefined, {
        env: { DEEPSEEK_API_KEY: 'offline-secret' },
        prepareWorkspace,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: 'DEEPSEEK_MODEL_MISSING',
    });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs only the fixed task through the verified snapshot and read-only tools', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          type: 'tool_call',
          callId: 'pilot-list-1',
          toolName: 'repo.list_files',
          args: {},
        }),
      )
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          type: 'final_answer',
          content: 'The verified snapshot contains the permitted source files.',
        }),
      );
    const output: string[] = [];
    let workspaceDirectory: string | undefined;
    const artifactDirectory = await temporaryArtifactDirectory();

    await runPilotTaskCommand(acceptedArgs, (message) => output.push(message), {
      env: {
        DEEPSEEK_API_KEY: 'offline-secret',
        DEEPSEEK_MODEL: 'deepseek-flash',
      },
      artifactDirectory,
      repositoryRoot: process.cwd(),
      fetch: fetchMock,
      prepareWorkspace: async (repositoryRoot) => {
        const workspace = await preparePilotWorkspace(repositoryRoot);
        workspaceDirectory = workspace.rootDirectory;
        return workspace;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(firstBody.model).toBe('deepseek-flash');
    expect(firstBody.max_tokens).toBe(4_096);
    expect(firstBody.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    const firstContext = JSON.parse(firstBody.messages[1]?.content ?? '') as {
      taskInput: string;
      visibleTools: Array<{ name: string }>;
    };
    expect(firstContext.visibleTools.map(({ name }) => name)).toContain('repo.list_files');
    expect(firstContext.taskInput).toContain('请基于工作区源码说明');
    expect(firstContext.taskInput).toContain('CONTEXT_BUDGET_EXCEEDED');
    expect(firstContext.taskInput).toContain('只调用 repo.read_file_lines 三次');
    expect(firstContext.taskInput).toContain('src/core/context-window.ts 第 90-129 行');
    expect(firstContext.taskInput).toContain('三次读取后立即给出 final_answer');
    expect(firstContext.taskInput).toContain('最终答复控制在 500 字以内');
    expect(firstBody.messages[1]?.content).not.toContain('应观察到的行为');
    expect(firstBody.messages[1]?.content).not.toContain('评分依据');

    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.messages[1]?.content).toContain('repo.list_files');
    expect(secondBody.messages[1]?.content).toContain('tool_result');
    expect(JSON.stringify([firstBody, secondBody])).not.toContain('offline-secret');
    expect(output).toContain('Pilot task completed.');
    expect(output).toContain('Offline Replay verified: 2 turn(s).');
    expect(output).toContain('"The verified snapshot contains the permitted source files."');
    expect(workspaceDirectory).toBeDefined();
    expect(existsSync(workspaceDirectory!)).toBe(false);

    const index = createSqliteRunIndex({ path: join(artifactDirectory, 'pilot-runs.sqlite') });
    try {
      const [indexedRun] = index.listRuns();
      if (indexedRun === undefined) {
        throw new Error('The pilot run was not indexed');
      }
      expect(indexedRun).toMatchObject({
        status: 'completed',
        configId: 'deepseek-pilot-task',
        model: { provider: 'deepseek', name: 'deepseek-flash' },
      });
      expect(indexedRun.artifacts.manifest.endsWith('run-manifest.json')).toBe(true);
      expect(indexedRun.artifacts.trace.endsWith('trace.jsonl')).toBe(true);
      expect(indexedRun.artifacts.finalOutput.endsWith('final-output.json')).toBe(true);
      const sessionDirectory = dirname(join(artifactDirectory, indexedRun.artifacts.manifest));
      const loaded = await loadTraceRun({ sessionDirectory });
      const provenance = loaded.manifest.provenance;
      expect(provenance).toBeDefined();
      if (provenance === undefined) {
        throw new Error('Pilot provenance was not persisted');
      }
      expect(provenance.schemaVersion).toBe(1);
      expect(provenance.sourceSnapshot.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(provenance.sourceSnapshot.files).toHaveLength(5);
      expect(provenance.sourceSnapshot.files.map(({ path }) => path)).toContain(
        'src/core/runtime.ts',
      );
      expect(
        provenance.sourceSnapshot.files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)),
      ).toBe(true);
      expect(provenance.redaction).toEqual({
        schemaVersion: 1,
        toolCallArguments: 'redacted',
        sensitiveFields: 'rejected',
        arbitraryText: 'not_scanned',
      });
      expect(loaded.manifest.configSummary.tools.enabled).toEqual([
        'repo.list_files',
        'repo.search_source',
        'repo.read_file_lines',
      ]);
      expect(loaded.manifest.configSummary.context).toMatchObject({
        maxCharacters: 24_000,
        observationMaxCharacters: 5_000,
      });
      expect(loaded.events.map(({ eventType }) => eventType)).toContain('context.built');
      const modelRequests = loaded.events.filter((event) => event.eventType === 'model.requested');
      expect(modelRequests).toHaveLength(2);
      const completedTools = loaded.events.filter((event) => event.eventType === 'tool.completed');
      expect(completedTools).toHaveLength(1);
      expect(completedTools[0]).toMatchObject({
        payload: { callId: 'pilot-list-1', toolName: 'repo.list_files' },
      });
      expectContextRequestsAligned(loaded.events);
      expect(analyzeTraceConsistency(loaded, { sqliteStatus: indexedRun.status }).consistent).toBe(
        true,
      );
      const requestCountBeforeReplay = fetchMock.mock.calls.length;
      const replay = replayLoadedTrace(loaded);
      expect(replay.finalOutput).toBe('The verified snapshot contains the permitted source files.');
      expect(replay.turns[0]?.observations).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(requestCountBeforeReplay);
      expect(loaded.events.filter(({ eventType }) => eventType === 'tool.completed')).toHaveLength(
        1,
      );
      expect(JSON.stringify(loaded)).not.toContain('offline-secret');

      await writeFile(join(sessionDirectory, 'trace.jsonl'), 'tampered\n', 'utf8');
      await expect(loadTraceRun({ sessionDirectory })).rejects.toMatchObject({
        code: 'TRACE_HASH_MISMATCH',
      } satisfies Partial<TraceIntegrityError>);
    } finally {
      index.close();
    }
  }, 15_000);

  it('persists and replays a failed run with its completed tool observation', async () => {
    const artifactDirectory = await temporaryArtifactDirectory();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          type: 'tool_call',
          callId: 'pilot-list-before-failure',
          toolName: 'repo.list_files',
          args: {},
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'private provider response' }, { status: 500 }),
      );
    const output: string[] = [];
    let workspaceDirectory: string | undefined;

    await expect(
      runPilotTaskCommand(acceptedArgs, (message) => output.push(message), {
        env: {
          DEEPSEEK_API_KEY: 'offline-secret',
          DEEPSEEK_MODEL: 'deepseek-flash',
        },
        artifactDirectory,
        repositoryRoot: process.cwd(),
        fetch: fetchMock,
        prepareWorkspace: async (repositoryRoot) => {
          const workspace = await preparePilotWorkspace(repositoryRoot);
          workspaceDirectory = workspace.rootDirectory;
          return workspace;
        },
      }),
    ).rejects.toMatchObject({
      name: 'PilotTaskError',
      code: 'MODEL_CALL_FAILED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workspaceDirectory).toBeDefined();
    expect(existsSync(workspaceDirectory!)).toBe(false);
    expect(output).toContain('Pilot task failed.');
    expect(output.join('\n')).toContain('"code": "MODEL_CALL_FAILED"');

    const index = createSqliteRunIndex({ path: join(artifactDirectory, 'pilot-runs.sqlite') });
    try {
      const [indexedRun] = index.listRuns();
      if (indexedRun === undefined) {
        throw new Error('The failed pilot run was not indexed');
      }
      expect(indexedRun.status).toBe('failed');
      const sessionDirectory = dirname(join(artifactDirectory, indexedRun.artifacts.manifest));
      const loaded = await loadTraceRun({ sessionDirectory });
      expect(loaded.manifest.status).toBe('failed');
      expect(loaded.events.map(({ eventType }) => eventType)).toContain('session.failed');
      const modelRequests = loaded.events.filter((event) => event.eventType === 'model.requested');
      expect(modelRequests).toHaveLength(2);
      const completedTools = loaded.events.filter((event) => event.eventType === 'tool.completed');
      expect(completedTools).toHaveLength(1);
      expect(completedTools[0]).toMatchObject({
        payload: {
          callId: 'pilot-list-before-failure',
          toolName: 'repo.list_files',
        },
      });
      expectContextRequestsAligned(loaded.events);
      expect(analyzeTraceConsistency(loaded, { sqliteStatus: indexedRun.status }).consistent).toBe(
        true,
      );
      const requestCountBeforeReplay = fetchMock.mock.calls.length;
      const replay = replayLoadedTrace(loaded);
      expect(replay).toMatchObject({
        status: 'failed',
        failure: { code: 'MODEL_CALL_FAILED' },
        turns: [
          {
            observations: [
              {
                type: 'tool_result',
                callId: 'pilot-list-before-failure',
                toolName: 'repo.list_files',
              },
            ],
          },
        ],
      });
      expect(replay.turns[0]?.observations).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(requestCountBeforeReplay);
      expect(loaded.events.filter(({ eventType }) => eventType === 'tool.completed')).toHaveLength(
        1,
      );
      expect(JSON.stringify(loaded)).not.toContain('offline-secret');
      expect(JSON.stringify(loaded)).not.toContain('private provider response');
    } finally {
      index.close();
    }
  }, 15_000);

  it('blocks execution when scoring material is added to the verified snapshot', async () => {
    const artifactDirectory = await temporaryArtifactDirectory();
    const fetchMock = vi.fn<typeof fetch>();
    const output: string[] = [];
    let workspaceDirectory: string | undefined;

    await expect(
      runPilotTaskCommand(acceptedArgs, (message) => output.push(message), {
        env: {
          DEEPSEEK_API_KEY: 'offline-secret',
          DEEPSEEK_MODEL: 'deepseek-flash',
        },
        artifactDirectory,
        repositoryRoot: process.cwd(),
        fetch: fetchMock,
        prepareWorkspace: async (repositoryRoot) => {
          const workspace = await preparePilotWorkspace(repositoryRoot);
          workspaceDirectory = workspace.rootDirectory;
          await writeFile(
            join(workspace.rootDirectory, 'scoring-rubric.md'),
            'private expected answer and scoring criteria',
            'utf8',
          );
          return workspace;
        },
      }),
    ).rejects.toMatchObject({
      name: 'PilotTaskError',
      code: 'PILOT_WORKSPACE_FAILED',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(workspaceDirectory).toBeDefined();
    expect(existsSync(workspaceDirectory!)).toBe(false);
    expect(existsSync(join(artifactDirectory, 'pilot-runs.sqlite'))).toBe(false);
  }, 15_000);

  it('returns the Runtime invalid-action code without exposing raw response details', async () => {
    const artifactDirectory = await temporaryArtifactDirectory();
    let workspaceDirectory: string | undefined;
    const invalidAction = {
      schemaVersion: 1,
      type: 'not-an-action',
      private: 'must-not-be-printed',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(invalidAction))
      .mockResolvedValueOnce(response(invalidAction));
    const write = vi.fn<(message: string) => void>();

    try {
      await expect(
        runPilotTaskCommand(acceptedArgs, write, {
          env: {
            DEEPSEEK_API_KEY: 'offline-secret',
            DEEPSEEK_MODEL: 'deepseek-flash',
          },
          artifactDirectory,
          repositoryRoot: process.cwd(),
          fetch: fetchMock,
          prepareWorkspace: async (repositoryRoot) => {
            const workspace = await preparePilotWorkspace(repositoryRoot);
            workspaceDirectory = workspace.rootDirectory;
            return workspace;
          },
        }),
      ).rejects.toMatchObject({
        name: 'PilotTaskError',
        code: 'MODEL_OUTPUT_INVALID',
      });
      expect(write).toHaveBeenCalled();
      expect(JSON.stringify(write.mock.calls)).not.toContain('must-not-be-printed');
    } finally {
      expect(workspaceDirectory).toBeDefined();
      expect(existsSync(workspaceDirectory!)).toBe(false);
    }
  }, 15_000);

  it('uses a stable public error for malformed command arguments', async () => {
    await expect(
      runPilotTaskCommand(['--unknown'], () => undefined, {
        env: { DEEPSEEK_API_KEY: 'offline-secret' },
      }),
    ).rejects.toBeInstanceOf(PilotTaskError);
    await expect(
      runPilotTaskCommand(['--unknown'], () => undefined, {
        env: { DEEPSEEK_API_KEY: 'offline-secret' },
      }),
    ).rejects.toMatchObject({ code: 'PILOT_ARGUMENTS_INVALID' });
  });
});
