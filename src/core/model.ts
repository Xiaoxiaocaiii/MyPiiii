import { z } from 'zod';

import { experimentConfigSchema, type ExperimentConfig } from './config.js';
import { modelContextViewSchema } from './context-window.js';
import { jsonValueSchema, observationSchema, sessionSchema } from './contracts.js';

export const modelRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionSchema.shape.sessionId,
  turnIndex: z.number().int().nonnegative(),
  inputMessage: z.string().min(1),
  model: experimentConfigSchema.shape.model,
  observations: z.array(observationSchema).optional(),
  context: modelContextViewSchema.optional(),
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
