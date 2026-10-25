import {
  jsonValueSchema,
  observationSchema,
  type AgentAction,
  type JsonValue,
  type Observation,
} from './contracts.js';
import {
  createToolContext,
  isToolPermitted,
  type ToolPermissionGrants,
} from './tool-permissions.js';
import type { ToolRegistry } from './tool-registry.js';
import { ToolError, type ToolContext, type ToolErrorCode } from './tool.js';

export type ToolCallAction = Extract<AgentAction, { type: 'tool_call' }>;

export interface ToolExecutionOptions {
  readonly context: ToolContext;
  readonly enabledTools: readonly string[];
  readonly now?: () => number;
  readonly permissions?: ToolPermissionGrants;
}

type RegisteredToolDefinition = ReturnType<ToolRegistry['resolve']>;

type ToolExecutionOutcome =
  | { readonly status: 'completed'; readonly output: JsonValue }
  | { readonly status: 'permission_denied' }
  | { readonly status: 'timed_out' }
  | { readonly status: 'aborted' }
  | { readonly status: 'failed' };

const toolTimeoutReason = new Error('Tool execution timed out');
const toolAbortReason = new Error('Tool execution aborted');

export async function executeToolCall(
  action: ToolCallAction,
  registry: ToolRegistry,
  options: ToolExecutionOptions,
): Promise<Observation> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const context = createToolContext({
    scenarioId: options.context.scenarioId,
    signal: options.context.signal,
    ...(options.context.workspace === undefined
      ? {}
      : { workspaceRoot: options.context.workspace.rootDirectory }),
  });
  let definition: RegisteredToolDefinition;

  try {
    definition = registry.resolve(
      action.toolName,
      options.context.scenarioId,
      options.enabledTools,
    );
  } catch (error) {
    if (error instanceof ToolError) {
      return createErrorObservation(action, error, elapsed(now, startedAt));
    }
    throw error;
  }

  if (!isToolPermitted(definition.sideEffect, options.permissions ?? {}, context)) {
    return createErrorObservation(
      action,
      new ToolError('PERMISSION_DENIED'),
      elapsed(now, startedAt),
    );
  }

  const input = definition.inputSchema.safeParse(action.args);
  if (!input.success) {
    return createErrorObservation(action, new ToolError('INPUT_INVALID'), elapsed(now, startedAt));
  }

  const execution = await executeWithBoundaries(definition, input.data, context);
  switch (execution.status) {
    case 'permission_denied':
      return createErrorObservation(
        action,
        new ToolError('PERMISSION_DENIED'),
        elapsed(now, startedAt),
      );
    case 'timed_out':
      return createErrorObservation(action, new ToolError('TIMEOUT'), elapsed(now, startedAt));
    case 'aborted':
    case 'failed':
      return createErrorObservation(
        action,
        new ToolError('EXECUTION_FAILED'),
        elapsed(now, startedAt),
      );
    case 'completed':
      break;
  }

  const output = definition.outputSchema.safeParse(execution.output);
  if (!output.success) {
    return createErrorObservation(action, new ToolError('OUTPUT_INVALID'), elapsed(now, startedAt));
  }

  const jsonOutput = jsonValueSchema.safeParse(output.data);
  if (!jsonOutput.success) {
    return createErrorObservation(action, new ToolError('OUTPUT_INVALID'), elapsed(now, startedAt));
  }

  return observationSchema.parse({
    schemaVersion: 1,
    type: 'tool_result',
    callId: action.callId,
    toolName: action.toolName,
    data: jsonOutput.data,
    truncated: isOutputTruncated(jsonOutput.data),
    durationMs: elapsed(now, startedAt),
  });
}

function isOutputTruncated(output: JsonValue): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    output.truncated === true
  );
}

function createErrorObservation(
  action: ToolCallAction,
  error: ToolError,
  durationMs: number,
): Observation {
  return observationSchema.parse({
    schemaVersion: 1,
    type: 'tool_error',
    callId: action.callId,
    toolName: action.toolName,
    code: error.code,
    message: error.message,
    retryable: isRetryable(error.code),
    durationMs,
  });
}

function isRetryable(code: ToolErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'EXECUTION_FAILED';
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function executeWithBoundaries(
  definition: RegisteredToolDefinition,
  input: unknown,
  parentContext: ToolContext,
): Promise<ToolExecutionOutcome> {
  if (parentContext.signal.aborted) {
    return Promise.resolve({ status: 'aborted' });
  }

  return new Promise((resolveExecution) => {
    const controller = new AbortController();
    const context = createToolContext({
      scenarioId: parentContext.scenarioId,
      signal: controller.signal,
      ...(parentContext.workspace === undefined
        ? {}
        : { workspaceRoot: parentContext.workspace.rootDirectory }),
    });
    let settled = false;

    const finish = (outcome: ToolExecutionOutcome): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      parentContext.signal.removeEventListener('abort', onParentAbort);
      resolveExecution(outcome);
    };
    const onParentAbort = (): void => {
      controller.abort(toolAbortReason);
      finish({ status: 'aborted' });
    };

    parentContext.signal.addEventListener('abort', onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(toolTimeoutReason);
      finish({ status: 'timed_out' });
    }, definition.timeoutMs);

    void Promise.resolve()
      .then(() => definition.execute(input, context))
      .then(
        (output) => {
          finish({ status: 'completed', output });
        },
        (error: unknown) => {
          if (error instanceof ToolError && error.code === 'PERMISSION_DENIED') {
            finish({ status: 'permission_denied' });
            return;
          }
          finish({ status: 'failed' });
        },
      );
  });
}
