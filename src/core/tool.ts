import { z } from 'zod';

import type { JsonValue } from './contracts.js';

const toolIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const toolSideEffectSchema = z.enum(['none', 'local_write', 'external']);

export type ToolSideEffect = z.infer<typeof toolSideEffectSchema>;

export const toolDefinitionMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: toolIdentifierSchema,
  description: z.string().trim().min(1).max(1024),
  timeoutMs: z.number().int().positive(),
  sideEffect: toolSideEffectSchema,
  allowedScenarios: z
    .array(toolIdentifierSchema)
    .min(1)
    .refine((scenarios) => new Set(scenarios).size === scenarios.length, {
      message: 'Expected unique scenario identifiers',
    }),
});

export type ToolDefinitionMetadata = z.infer<typeof toolDefinitionMetadataSchema>;

export interface ToolWorkspace {
  readonly rootDirectory: string;
  readonly resolvePath: (path: string) => string;
}

export interface ToolContext {
  readonly scenarioId: string;
  readonly signal: AbortSignal;
  readonly workspace?: ToolWorkspace;
}

type ToolExecutor<I, O extends JsonValue> = {
  execute(input: I, context: ToolContext): Promise<O>;
}['execute'];

export interface ToolDefinition<I, O extends JsonValue> extends ToolDefinitionMetadata {
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly execute: ToolExecutor<I, O>;
}

export const toolErrorCodes = [
  'TOOL_NOT_FOUND',
  'INPUT_INVALID',
  'PERMISSION_DENIED',
  'TIMEOUT',
  'EXECUTION_FAILED',
  'OUTPUT_INVALID',
] as const;

export const toolErrorCodeSchema = z.enum(toolErrorCodes);

export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

const toolErrorMessages: Record<ToolErrorCode, string> = {
  TOOL_NOT_FOUND: 'The requested tool is not available',
  INPUT_INVALID: 'The tool input is invalid',
  PERMISSION_DENIED: 'The tool call is not permitted',
  TIMEOUT: 'The tool call timed out',
  EXECUTION_FAILED: 'The tool execution failed',
  OUTPUT_INVALID: 'The tool returned an invalid output',
};

export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, options?: ErrorOptions) {
    super(toolErrorMessages[code], options);
    this.code = code;
  }
}
