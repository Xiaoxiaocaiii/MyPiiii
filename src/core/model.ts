import { z } from 'zod';

import { experimentConfigSchema, type ExperimentConfig } from './config.js';
import { modelContextViewSchema } from './context-window.js';
import { jsonValueSchema, observationSchema, sessionSchema } from './contracts.js';
import { toolDescriptionSchema } from './tool-registry.js';

export const modelRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sessionId: sessionSchema.shape.sessionId,
    turnIndex: z.number().int().nonnegative(),
    inputMessage: z.string().min(1),
    model: experimentConfigSchema.shape.model,
    observations: z.array(observationSchema).optional(),
    context: modelContextViewSchema.optional(),
    tools: z.array(toolDescriptionSchema).optional(),
  })
  .superRefine((request, context) => {
    if (request.context === undefined) {
      return;
    }

    if (request.context.taskInput !== request.inputMessage) {
      context.addIssue({
        code: 'custom',
        message: 'The task input must match the Context view',
        path: ['context', 'taskInput'],
      });
    }

    if (
      request.context.visibleTools !== undefined &&
      JSON.stringify(request.context.visibleTools) !== JSON.stringify(request.tools ?? [])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Visible tools must match the Context view',
        path: ['tools'],
      });
    }
  });

export type ModelRequest = z.infer<typeof modelRequestSchema>;
export type ModelParameters = ExperimentConfig['model'];

export const modelResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  output: jsonValueSchema,
});

export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface ModelCallOptions {
  signal: AbortSignal;
  onAttemptDiagnostic?: (diagnostic: ModelAttemptDiagnostic) => void | Promise<void>;
}

export class ModelAttemptDiagnosticError extends Error {
  override readonly name = 'ModelAttemptDiagnosticError';

  constructor() {
    super('The model attempt diagnostic could not be persisted');
  }
}

export interface ModelAttemptDiagnostic {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly modelName: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly remoteModel: string | null;
  readonly finishReason: 'stop' | 'length' | 'other' | null;
  readonly usage: {
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly totalTokens: number | null;
  } | null;
  readonly costEstimate: {
    readonly status: 'unknown';
    readonly amountUsd: null;
    readonly reason: 'pricing_not_frozen';
  };
  readonly responseParseCategory:
    | 'accepted'
    | 'json_parse_recovered'
    | 'invalid_provider_json'
    | 'invalid_provider_response'
    | 'empty_content'
    | 'invalid_action_json'
    | 'invalid_response_schema'
    | 'http_error'
    | 'transport_error'
    | 'cancelled';
  readonly actionSchemaValid: boolean | null;
}

export interface ModelAdapter {
  complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse>;
}

export const modelAdapterErrorCodes = [
  'MODEL_CALL_FAILED',
  'MODEL_CALL_ABORTED',
  'MODEL_RESPONSE_INVALID',
] as const;

export type ModelAdapterErrorCode = (typeof modelAdapterErrorCodes)[number];

const modelAdapterErrorMessages: Record<ModelAdapterErrorCode, string> = {
  MODEL_CALL_FAILED: 'The model call failed',
  MODEL_CALL_ABORTED: 'The model call was aborted',
  MODEL_RESPONSE_INVALID: 'The model returned an invalid response',
};

export class ModelAdapterError extends Error {
  override readonly name = 'ModelAdapterError';
  readonly code: ModelAdapterErrorCode;

  constructor(code: ModelAdapterErrorCode, options?: ErrorOptions) {
    super(modelAdapterErrorMessages[code], options);
    this.code = code;
  }
}
