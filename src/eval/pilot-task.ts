import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { experimentConfigSchema } from '../core/config.js';
import { DeepSeekModelAdapter } from '../core/deepseek-model.js';
import { runAgent } from '../core/runtime.js';
import { createArtifactRun } from '../observability/artifact-run.js';
import { createSqliteRunIndex } from '../observability/sqlite-run-index.js';
import { loadTraceRun } from '../observability/trace-loader.js';
import { analyzeTraceConsistency } from '../observability/trace-consistency.js';
import { replayLoadedTrace, type ReplayResult } from '../observability/trace-replay.js';
import { TraceRecorder } from '../observability/trace-recorder.js';
import { createPilotToolRegistry, pilotToolNames } from './pilot-tools.js';
import {
  preparePilotWorkspace,
  verifyPilotWorkspace,
  type PilotWorkspace,
} from './pilot-workspace.js';

const pilotTaskInput = [
  '请基于工作区源码说明：MyPiiii 如何为后续模型调用构建上下文？当历史轮次或工具结果放不进预算时会怎样处理？什么条件下才会以 `CONTEXT_BUDGET_EXCEEDED` 失败？',
  '严格按以下顺序取证，只调用 repo.read_file_lines 三次：',
  '1. 读取 src/core/context-window.ts 第 90-129 行。',
  '2. 读取 src/core/context-window.ts 第 145-224 行。',
  '3. 读取 src/core/runtime.ts 第 141-190 行。',
  '不要调用 repo.list_files 或 repo.search_source，不要重复或扩展读取范围。三次读取后立即给出 final_answer。',
  '用仓库相对路径和行号区分“省略历史或观察结果”和“终止运行”；最终答复控制在 500 字以内。若工具失败或源码不足，明确说明，不要继续搜索。',
].join('\n');

export type PilotTaskErrorCode =
  | 'PILOT_ARGUMENTS_INVALID'
  | 'DEEPSEEK_API_KEY_MISSING'
  | 'DEEPSEEK_MODEL_MISSING'
  | 'PAID_CALL_CONFIRMATION_REQUIRED'
  | 'PILOT_WORKSPACE_FAILED'
  | 'PILOT_WORKSPACE_CLEANUP_FAILED'
  | 'PILOT_RUN_FAILED'
  | 'MAX_TURNS_EXCEEDED'
  | 'RUN_TIMEOUT'
  | 'MODEL_CALL_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'UNSUPPORTED_ACTION'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'ABORTED';

const pilotTaskErrorMessages: Record<PilotTaskErrorCode, string> = {
  PILOT_ARGUMENTS_INVALID: 'The pilot task arguments are invalid',
  DEEPSEEK_API_KEY_MISSING: 'Set DEEPSEEK_API_KEY to run the DeepSeek pilot task',
  DEEPSEEK_MODEL_MISSING:
    'Set DEEPSEEK_MODEL to a model ID currently accepted by DeepSeek Chat Completions',
  PAID_CALL_CONFIRMATION_REQUIRED:
    'Pass --confirm-paid-call only after confirming the model and current pricing',
  PILOT_WORKSPACE_FAILED: 'The verified pilot workspace could not be prepared',
  PILOT_WORKSPACE_CLEANUP_FAILED: 'The temporary pilot workspace could not be removed',
  PILOT_RUN_FAILED: 'The pilot task could not be completed',
  MAX_TURNS_EXCEEDED: 'The Runtime reached the maximum number of turns',
  RUN_TIMEOUT: 'The Runtime timed out',
  MODEL_CALL_FAILED: 'The DeepSeek model call failed',
  MODEL_OUTPUT_INVALID: 'The model output is invalid',
  UNSUPPORTED_ACTION: 'The model requested an unsupported action',
  CONTEXT_BUDGET_EXCEEDED: 'The required context exceeds the character budget',
  ABORTED: 'The pilot task was aborted',
};

export class PilotTaskError extends Error {
  override readonly name = 'PilotTaskError';
  readonly code: PilotTaskErrorCode;

  constructor(code: PilotTaskErrorCode) {
    super(pilotTaskErrorMessages[code]);
    this.code = code;
  }
}

export interface PilotTaskCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly repositoryRoot?: string;
  readonly artifactDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly prepareWorkspace?: (repositoryRoot: string) => Promise<PilotWorkspace>;
}

export async function runPilotTaskCommand(
  args: readonly string[],
  write: (message: string) => void,
  options: PilotTaskCommandOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new PilotTaskError('DEEPSEEK_API_KEY_MISSING');
  }
  if (args.length === 0) {
    throw new PilotTaskError('PAID_CALL_CONFIRMATION_REQUIRED');
  }
  if (args.length !== 1 || args[0] !== '--confirm-paid-call') {
    throw new PilotTaskError('PILOT_ARGUMENTS_INVALID');
  }
  const modelName = env.DEEPSEEK_MODEL?.trim();
  if (modelName === undefined || modelName.length === 0) {
    throw new PilotTaskError('DEEPSEEK_MODEL_MISSING');
  }

  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  let workspace: PilotWorkspace | undefined;
  let commandError: PilotTaskError | undefined;
  let reportMessages: string[] | undefined;
  try {
    try {
      workspace = await (options.prepareWorkspace ?? preparePilotWorkspace)(repositoryRoot);
    } catch {
      throw new PilotTaskError('PILOT_WORKSPACE_FAILED');
    }
    try {
      workspace = await verifyPilotWorkspace(repositoryRoot, workspace.rootDirectory);
    } catch {
      throw new PilotTaskError('PILOT_WORKSPACE_FAILED');
    }

    const persisted = await runPilotTaskWithArtifacts({
      apiKey,
      modelName,
      repositoryRoot,
      workspace,
      ...(options.artifactDirectory === undefined
        ? {}
        : { artifactDirectory: options.artifactDirectory }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    reportMessages = [
      `Pilot task ${persisted.replay.status}.`,
      `Session: ${persisted.replay.sessionId}`,
      `Artifacts: ${persisted.sessionDirectory}`,
      `Offline Replay verified: ${persisted.replay.turns.length} turn(s).`,
      JSON.stringify(
        persisted.replay.status === 'completed'
          ? (persisted.replay.finalOutput ?? null)
          : persisted.replay.failure,
        null,
        2,
      ),
    ];
    if (persisted.replay.status === 'failed') {
      const failureCode = persisted.replay.failure?.code;
      commandError = new PilotTaskError(
        failureCode !== undefined && isPilotTaskErrorCode(failureCode)
          ? failureCode
          : 'PILOT_RUN_FAILED',
      );
    }
  } catch (error) {
    commandError = error instanceof PilotTaskError ? error : new PilotTaskError('PILOT_RUN_FAILED');
  }

  if (workspace !== undefined) {
    try {
      await rm(workspace.rootDirectory, { recursive: true });
    } catch {
      commandError = new PilotTaskError('PILOT_WORKSPACE_CLEANUP_FAILED');
    }
  }

  if (commandError !== undefined) {
    for (const message of reportMessages ?? []) {
      write(message);
    }
    throw commandError;
  }
  for (const message of reportMessages ?? []) {
    write(message);
  }
}

interface PersistPilotTaskOptions {
  readonly apiKey: string;
  readonly modelName: string;
  readonly repositoryRoot: string;
  readonly workspace: PilotWorkspace;
  readonly artifactDirectory?: string;
  readonly fetch?: typeof fetch;
}

interface PersistedPilotTask {
  readonly sessionDirectory: string;
  readonly replay: ReplayResult;
}

async function runPilotTaskWithArtifacts(
  options: PersistPilotTaskOptions,
): Promise<PersistedPilotTask> {
  const config = experimentConfigSchema.parse({
    schemaVersion: 1,
    configId: 'deepseek-pilot-task',
    scenarioId: 'repo-qa',
    model: {
      provider: 'deepseek',
      name: options.modelName,
      temperature: 0,
      maxOutputTokens: 4_096,
    },
    runtime: {
      maxTurns: 8,
      timeoutMs: 120_000,
    },
    context: {
      maxCharacters: 24_000,
      recentTurns: 4,
      observationMaxCharacters: 5_000,
    },
    tools: {
      enabled: [...pilotToolNames],
    },
  });
  const artifactDirectory = resolve(
    options.artifactDirectory ?? join(options.repositoryRoot, 'artifacts', 'pilot-runs'),
  );
  await mkdir(artifactDirectory, { recursive: true });

  const sessionId = randomUUID();
  const createdAt = new Date();
  const runIndex = createSqliteRunIndex({
    path: join(artifactDirectory, 'pilot-runs.sqlite'),
  });
  let artifact: Awaited<ReturnType<typeof createArtifactRun>> | undefined;
  let artifactFinalized = false;
  let indexEntryCreated = false;
  try {
    artifact = await createArtifactRun({
      directory: artifactDirectory,
      sessionId,
      config,
      createdAt,
      provenance: {
        schemaVersion: 1,
        sourceSnapshot: {
          revision: options.workspace.revision,
          files: options.workspace.files.map(({ path, sha256 }) => ({ path, sha256 })),
        },
        redaction: {
          schemaVersion: 1,
          toolCallArguments: 'redacted',
          sensitiveFields: 'rejected',
          arbitraryText: 'not_scanned',
        },
      },
    });
    runIndex.createRun({
      schemaVersion: 1,
      sessionId,
      configId: config.configId,
      scenarioId: config.scenarioId,
      model: { provider: config.model.provider, name: config.model.name },
      createdAt: createdAt.toISOString(),
      artifacts: {
        manifest: relativeArtifactPath(artifact.paths.rootDirectory, artifact.paths.manifest),
        trace: relativeArtifactPath(artifact.paths.rootDirectory, artifact.paths.trace),
        finalOutput: relativeArtifactPath(artifact.paths.rootDirectory, artifact.paths.finalOutput),
      },
    });
    indexEntryCreated = true;

    const adapter = new DeepSeekModelAdapter({
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const result = await runAgent(
      {
        schemaVersion: 1,
        sessionId,
        inputMessage: pilotTaskInput,
        config,
      },
      adapter,
      {
        trace: { recorder: new TraceRecorder({ sessionId, sink: artifact.trace }) },
        tools: {
          registry: createPilotToolRegistry(options.workspace),
          workspaceRoot: options.workspace.rootDirectory,
        },
      },
    );
    const manifest = await artifact.finalize({
      status: result.status,
      completedAt: new Date(),
      finalOutput: result.status === 'completed' ? result.finalOutput : { error: result.error },
    });
    artifactFinalized = true;

    runIndex.finishRun({
      schemaVersion: 1,
      sessionId,
      status: manifest.status,
      completedAt: manifest.completedAt,
    });

    const loaded = await loadTraceRun({ sessionDirectory: artifact.paths.sessionDirectory });
    const indexedRun = runIndex.getRun(sessionId);
    const consistency = analyzeTraceConsistency(loaded, {
      ...(indexedRun === undefined ? {} : { sqliteStatus: indexedRun.status }),
    });
    if (!consistency.consistent) {
      throw new PilotTaskError('PILOT_RUN_FAILED');
    }

    return {
      sessionDirectory: artifact.paths.sessionDirectory,
      replay: replayLoadedTrace(loaded),
    };
  } catch (error) {
    if (artifact !== undefined && !artifactFinalized) {
      await artifact.abort('PILOT_RUN_FAILED').catch(() => undefined);
    }
    if (indexEntryCreated) {
      try {
        if (runIndex.getRun(sessionId)?.status === 'running') {
          runIndex.finishRun({
            schemaVersion: 1,
            sessionId,
            status: 'failed',
            completedAt: completionTime(createdAt),
          });
        }
      } catch {
        // Preserve the original stable command failure.
      }
    }
    throw error;
  } finally {
    runIndex.close();
  }
}

function relativeArtifactPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function completionTime(createdAt: Date): string {
  return new Date(Math.max(Date.now(), createdAt.getTime())).toISOString();
}

function isPilotTaskErrorCode(value: string): value is PilotTaskErrorCode {
  return value in pilotTaskErrorMessages;
}
