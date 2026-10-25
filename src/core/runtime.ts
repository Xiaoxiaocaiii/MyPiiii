import { z } from 'zod';

import { experimentConfigSchema } from './config.js';
import { buildContextWindow, ContextBudgetError } from './context-window.js';
import {
  agentActionSchema,
  jsonValueSchema,
  sessionSchema,
  turnSchema,
  type JsonValue,
  type Observation,
  type AgentAction,
  type Turn,
} from './contracts.js';
import {
  ModelAttemptDiagnosticError,
  ModelAdapterError,
  type ModelAttemptDiagnostic,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from './model.js';
import {
  createToolContext,
  isToolPermitted,
  type ToolPermissionGrants,
} from './tool-permissions.js';
import type { ToolRegistry } from './tool-registry.js';
import { executeToolCall } from './tool-runtime.js';
import type { TraceEventInput, TraceRecorder } from '../observability/trace-recorder.js';

export const runtimeInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionSchema.shape.sessionId,
  inputMessage: z.string().min(1),
  config: experimentConfigSchema,
});

export type RuntimeInput = z.infer<typeof runtimeInputSchema>;

export const runtimeFailureCodeSchema = z.enum([
  'MAX_TURNS_EXCEEDED',
  'RUN_TIMEOUT',
  'MODEL_CALL_FAILED',
  'MODEL_DIAGNOSTIC_FAILED',
  'MODEL_OUTPUT_INVALID',
  'UNSUPPORTED_ACTION',
  'CONTEXT_BUDGET_EXCEEDED',
  'ABORTED',
]);

export type RuntimeFailureCode = z.infer<typeof runtimeFailureCodeSchema>;

const runtimeSuccessSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('completed'),
  finalOutput: jsonValueSchema,
  turns: z.array(turnSchema),
});

const runtimeFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('failed'),
  error: z.strictObject({
    code: runtimeFailureCodeSchema,
    message: z.string().min(1),
    cause: z
      .strictObject({
        name: z.string().min(1),
        code: z.string().min(1).optional(),
      })
      .optional(),
  }),
  turns: z.array(turnSchema),
});

export const runtimeResultSchema = z.discriminatedUnion('status', [
  runtimeSuccessSchema,
  runtimeFailureSchema,
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export interface RuntimeToolOptions {
  readonly registry: ToolRegistry;
  readonly permissions?: ToolPermissionGrants;
  readonly workspaceRoot?: string;
}

export interface RuntimeRunOptions {
  signal?: AbortSignal;
  beforeModelRequest?: (request: ModelRequest, signal: AbortSignal) => Promise<void>;
  onModelAttemptDiagnostic?: (diagnostic: ModelAttemptDiagnostic) => void | Promise<void>;
  tools?: RuntimeToolOptions;
  trace?: {
    readonly recorder: TraceRecorder;
  };
}

const timeoutReason = new Error('Runtime timeout');
const externalAbortReason = new Error('Runtime externally aborted');

export class RuntimeTraceError extends Error {
  override readonly name = 'RuntimeTraceError';
  readonly code = 'TRACE_WRITE_FAILED' as const;

  constructor() {
    super('The runtime trace could not be persisted');
  }
}

export async function runAgent(
  input: RuntimeInput,
  adapter: ModelAdapter,
  options: RuntimeRunOptions = {},
): Promise<RuntimeResult> {
  const parsedInput = runtimeInputSchema.parse(input);
  const turns: Turn[] = [];
  const controller = new AbortController();
  let repairAttempted = false;
  const traceRecorder = options.trace?.recorder;

  const onExternalAbort = (): void => {
    controller.abort(externalAbortReason);
  };
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(timeoutReason);
  }, parsedInput.config.runtime.timeoutMs);

  try {
    if (traceRecorder !== undefined) {
      await recordTrace(traceRecorder, {
        eventType: 'session.started',
        turnIndex: null,
        payload: {
          configId: parsedInput.config.configId,
          scenarioId: parsedInput.config.scenarioId,
          model: {
            provider: parsedInput.config.model.provider,
            name: parsedInput.config.model.name,
          },
          inputMessage: parsedInput.inputMessage,
        },
      });
    }
    if (options.signal?.aborted === true) {
      return await tracedFailure('ABORTED', 'The runtime was aborted');
    }
    for (let turnIndex = 0; turnIndex < parsedInput.config.runtime.maxTurns; turnIndex += 1) {
      let output: unknown;

      try {
        const request = createModelRequest(
          parsedInput,
          turnIndex,
          turns,
          options.tools,
          controller.signal,
        );
        await options.beforeModelRequest?.(request, controller.signal);
        if (request.context !== undefined && traceRecorder !== undefined) {
          await recordTrace(traceRecorder, {
            eventType: 'context.built',
            turnIndex,
            payload: { context: request.context },
          });
        }
        if (traceRecorder !== undefined) {
          await recordTrace(traceRecorder, {
            eventType: 'model.requested',
            turnIndex,
            payload: { request },
          });
        }
        const response = await completeWithAbort(
          adapter,
          request,
          controller.signal,
          options.onModelAttemptDiagnostic,
        );
        await recordTrace(options.trace?.recorder, {
          eventType: 'model.responded',
          turnIndex,
          payload: { response: { ...response, output: redactTraceOutput(response.output) } },
        });
        output = response.output;
      } catch (error) {
        if (error instanceof ContextBudgetError) {
          return await tracedFailure(
            'CONTEXT_BUDGET_EXCEEDED',
            'The required context exceeds the character budget',
          );
        }
        if (controller.signal.reason === timeoutReason) {
          return await tracedFailure('RUN_TIMEOUT', 'The runtime timed out');
        }
        if (controller.signal.reason === externalAbortReason) {
          return await tracedFailure('ABORTED', 'The runtime was aborted');
        }
        if (error instanceof ModelAttemptDiagnosticError) {
          return await tracedFailure(
            'MODEL_DIAGNOSTIC_FAILED',
            'The model attempt diagnostic could not be persisted',
            diagnosticCause(error),
          );
        }
        if (error instanceof ModelAdapterError && error.code === 'MODEL_RESPONSE_INVALID') {
          return await tracedFailure(
            'MODEL_OUTPUT_INVALID',
            'The model output is invalid',
            diagnosticCause(error),
          );
        }

        return await tracedFailure(
          'MODEL_CALL_FAILED',
          'The model call failed',
          diagnosticCause(error),
        );
      }

      const parsedAction = agentActionSchema.safeParse(output);
      if (!parsedAction.success) {
        const turn = createTurn(parsedInput, turnIndex, output);
        if (repairAttempted) {
          turns.push({ ...turn, stopReason: 'MODEL_OUTPUT_INVALID' });
          await recordTraceTurn(options.trace?.recorder, turn, 'MODEL_OUTPUT_INVALID');
          return await tracedFailure('MODEL_OUTPUT_INVALID', 'The model output is invalid');
        }

        repairAttempted = true;
        turns.push(turn);
        await recordTraceTurn(options.trace?.recorder, turn);
        continue;
      }

      const action = parsedAction.data;
      const turn = createTurn(parsedInput, turnIndex, output, action);

      switch (action.type) {
        case 'final_answer':
          turns.push({ ...turn, stopReason: 'FINAL_ANSWER' });
          await recordTraceTurn(options.trace?.recorder, turn, 'FINAL_ANSWER');
          await recordTraceTerminal(
            options.trace?.recorder,
            'completed',
            undefined,
            turns.length,
            action.content,
          );
          return {
            schemaVersion: 1,
            status: 'completed',
            finalOutput: action.content,
            turns,
          };
        case 'tool_call': {
          const toolTurn = redactToolCallTurn(turn, action);
          if (options.tools === undefined || parsedInput.config.tools.enabled.length === 0) {
            turns.push({ ...toolTurn, stopReason: 'UNSUPPORTED_ACTION' });
            await recordTraceTurn(options.trace?.recorder, toolTurn, 'UNSUPPORTED_ACTION');
            await recordTraceTerminal(
              options.trace?.recorder,
              'failed',
              {
                code: 'UNSUPPORTED_ACTION',
                message: 'Tool calls are not supported by the no-tool runtime',
              },
              turns.length,
            );
            return failure(
              'UNSUPPORTED_ACTION',
              'Tool calls are not supported by the no-tool runtime',
              turns,
            );
          }

          if (traceRecorder !== undefined) {
            await recordTrace(traceRecorder, {
              eventType: 'tool.requested',
              turnIndex,
              payload: {
                callId: action.callId,
                toolName: action.toolName,
                args: { redacted: true },
              },
            });
          }
          const observation = await executeToolCall(action, options.tools.registry, {
            context: createToolContext({
              scenarioId: parsedInput.config.scenarioId,
              signal: controller.signal,
              ...(options.tools.workspaceRoot === undefined
                ? {}
                : { workspaceRoot: options.tools.workspaceRoot }),
            }),
            enabledTools: parsedInput.config.tools.enabled,
            ...(options.tools.permissions === undefined
              ? {}
              : { permissions: options.tools.permissions }),
          });
          await recordToolObservation(options.trace?.recorder, turnIndex, observation);
          const observedTurn = { ...toolTurn, observations: [observation] };

          if (controller.signal.reason === timeoutReason) {
            turns.push({ ...observedTurn, stopReason: 'RUN_TIMEOUT' });
            await recordTraceTurn(options.trace?.recorder, observedTurn, 'RUN_TIMEOUT');
            return await tracedFailure('RUN_TIMEOUT', 'The runtime timed out');
          }
          if (controller.signal.reason === externalAbortReason) {
            turns.push({ ...observedTurn, stopReason: 'ABORTED' });
            await recordTraceTurn(options.trace?.recorder, observedTurn, 'ABORTED');
            return await tracedFailure('ABORTED', 'The runtime was aborted');
          }

          turns.push(observedTurn);
          await recordTraceTurn(options.trace?.recorder, observedTurn);
          break;
        }
        case 'invalid':
          if (repairAttempted) {
            turns.push({ ...turn, stopReason: 'MODEL_OUTPUT_INVALID' });
            await recordTraceTurn(options.trace?.recorder, turn, 'MODEL_OUTPUT_INVALID');
            return await tracedFailure('MODEL_OUTPUT_INVALID', 'The model output is invalid');
          }

          repairAttempted = true;
          turns.push(turn);
          await recordTraceTurn(options.trace?.recorder, turn);
          break;
      }
    }

    return await tracedFailure(
      'MAX_TURNS_EXCEEDED',
      'The runtime reached the maximum number of turns',
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  async function tracedFailure(
    code: RuntimeFailureCode,
    message: string,
    cause?: { name: string; code?: string },
  ): Promise<RuntimeResult> {
    await recordTraceTerminal(options.trace?.recorder, 'failed', { code, message }, turns.length);
    return failure(code, message, turns, cause);
  }
}

function createModelRequest(
  input: RuntimeInput,
  turnIndex: number,
  turns: readonly Turn[],
  toolOptions: RuntimeToolOptions | undefined,
  signal: AbortSignal,
): ModelRequest {
  const availableTools =
    toolOptions === undefined ? [] : describePermittedTools(input, toolOptions, signal);
  const request: ModelRequest = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turnIndex,
    inputMessage: input.inputMessage,
    model: input.config.model,
    ...(availableTools.length === 0 ? {} : { tools: availableTools }),
    context: buildContextWindow({
      taskInput: input.inputMessage,
      turns,
      visibleTools: availableTools,
      ...(input.config.context === undefined ? {} : { settings: input.config.context }),
    }),
  };

  return request;
}

function describePermittedTools(
  input: RuntimeInput,
  toolOptions: RuntimeToolOptions,
  signal: AbortSignal,
): NonNullable<ModelRequest['tools']> {
  const scenarioId = input.config.scenarioId;
  const enabledTools = input.config.tools.enabled;
  const availableDefinitions = toolOptions.registry.listAvailable(scenarioId, enabledTools);
  const workspaceRoot =
    toolOptions.workspaceRoot?.trim().length === 0 ? undefined : toolOptions.workspaceRoot;
  const context = createToolContext({
    scenarioId,
    signal,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
  const permittedNames = availableDefinitions
    .filter((definition) =>
      isToolPermitted(definition.sideEffect, toolOptions.permissions ?? {}, context),
    )
    .map((definition) => definition.name);

  return toolOptions.registry.describeAvailable(scenarioId, permittedNames);
}

function createTurn(
  input: RuntimeInput,
  turnIndex: number,
  modelResponse: unknown,
  action?: AgentAction,
): Turn {
  return turnSchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    turnIndex,
    inputMessage: input.inputMessage,
    modelResponse,
    ...(action === undefined ? {} : { action }),
    observations: [],
  });
}

function redactToolCallTurn(turn: Turn, action: Extract<AgentAction, { type: 'tool_call' }>): Turn {
  const redactedAction = {
    ...action,
    args: { redacted: true },
  };

  return turnSchema.parse({
    ...turn,
    modelResponse: redactedAction,
    action: redactedAction,
  });
}

function redactTraceOutput(output: JsonValue): JsonValue {
  const parsed = agentActionSchema.safeParse(output);
  if (!parsed.success || parsed.data.type !== 'tool_call') {
    return output;
  }
  return { ...parsed.data, args: { redacted: true } };
}

function failure(
  code: RuntimeFailureCode,
  message: string,
  turns: Turn[],
  cause?: { name: string; code?: string },
): RuntimeResult {
  return {
    schemaVersion: 1,
    status: 'failed',
    error: {
      code,
      message,
      ...(cause === undefined ? {} : { cause }),
    },
    turns,
  };
}

function diagnosticCause(error: unknown): { name: string; code?: string } {
  if (error instanceof ModelAdapterError) {
    return { name: error.name, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name };
  }
  return { name: 'UnknownError' };
}

function completeWithAbort(
  adapter: ModelAdapter,
  request: ModelRequest,
  signal: AbortSignal,
  onAttemptDiagnostic: RuntimeRunOptions['onModelAttemptDiagnostic'],
): Promise<ModelResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Model call aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    void adapter
      .complete(request, {
        signal,
        ...(onAttemptDiagnostic === undefined
          ? {}
          : {
              onAttemptDiagnostic: async (diagnostic) => {
                try {
                  await onAttemptDiagnostic(diagnostic);
                } catch {
                  throw new ModelAttemptDiagnosticError();
                }
              },
            }),
      })
      .then(
        (response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error('Unknown model adapter failure'));
        },
      );
  });
}

async function recordTrace(
  recorder: TraceRecorder | undefined,
  input: TraceEventInput,
): Promise<void> {
  if (recorder === undefined) {
    return;
  }
  try {
    await recorder.record(input);
  } catch {
    throw new RuntimeTraceError();
  }
}

async function recordTraceTurn(
  recorder: TraceRecorder | undefined,
  turn: Turn,
  stopReason?: string,
): Promise<void> {
  await recordTrace(recorder, {
    eventType: 'turn.completed',
    turnIndex: turn.turnIndex,
    payload: {
      turn: stopReason === undefined ? turn : { ...turn, stopReason },
    },
  });
}

async function recordTraceTerminal(
  recorder: TraceRecorder | undefined,
  status: 'completed' | 'failed',
  error: { code: string; message: string } | undefined,
  turnCount: number,
  finalOutput?: unknown,
): Promise<void> {
  if (status === 'completed') {
    await recordTrace(recorder, {
      eventType: 'session.completed',
      turnIndex: null,
      payload: {
        finalOutput: jsonValueSchema.parse(finalOutput),
        turnCount,
      },
    });
    return;
  }

  await recordTrace(recorder, {
    eventType: 'session.failed',
    turnIndex: null,
    payload: {
      error: {
        code: error?.code ?? 'RUNTIME_FAILED',
        message: error?.message ?? 'The runtime failed',
      },
      turnCount,
    },
  });
}

async function recordToolObservation(
  recorder: TraceRecorder | undefined,
  turnIndex: number,
  observation: Observation,
): Promise<void> {
  if (observation.type === 'tool_result') {
    await recordTrace(recorder, {
      eventType: 'tool.completed',
      turnIndex,
      payload: {
        callId: observation.callId,
        toolName: observation.toolName,
        data: observation.data,
        truncated: observation.truncated,
        durationMs: observation.durationMs,
      },
    });
    return;
  }

  await recordTrace(recorder, {
    eventType: 'tool.failed',
    turnIndex,
    payload: {
      callId: observation.callId,
      toolName: observation.toolName,
      code: observation.code,
      message: observation.message,
      retryable: observation.retryable,
      durationMs: observation.durationMs,
    },
  });
}
