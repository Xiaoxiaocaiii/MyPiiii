import { open } from 'node:fs/promises';

import { z } from 'zod';

import type { ModelAttemptDiagnostic } from '../core/model.js';

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const modelNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
      }),
  );
const timestampSchema = z.string().datetime({ offset: true });

export const modelAttemptDiagnosticSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    turnIndex: z.number().int().nonnegative(),
    modelName: modelNameSchema,
    requestedAt: timestampSchema,
    completedAt: timestampSchema,
    durationMs: z.number().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    remoteModel: identifierSchema.nullable(),
    finishReason: z.enum(['stop', 'length', 'other']).nullable(),
    usage: z
      .strictObject({
        promptTokens: z.number().int().nonnegative().nullable(),
        completionTokens: z.number().int().nonnegative().nullable(),
        totalTokens: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
    costEstimate: z.strictObject({
      status: z.literal('unknown'),
      amountUsd: z.null(),
      reason: z.literal('pricing_not_frozen'),
    }),
    responseParseCategory: z.enum([
      'accepted',
      'json_parse_recovered',
      'invalid_provider_json',
      'invalid_provider_response',
      'empty_content',
      'invalid_action_json',
      'invalid_response_schema',
      'http_error',
      'transport_error',
      'cancelled',
    ]),
    actionSchemaValid: z.boolean().nullable(),
  })
  .superRefine((diagnostic, context) => {
    if (Date.parse(diagnostic.completedAt) < Date.parse(diagnostic.requestedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Completion time must not precede request time',
        path: ['completedAt'],
      });
    }
  });

export type PersistedModelAttemptDiagnostic = z.infer<typeof modelAttemptDiagnosticSchema>;

export type ModelAttemptDiagnosticsWriterErrorCode =
  'MODEL_DIAGNOSTIC_INVALID' | 'MODEL_DIAGNOSTIC_WRITE_FAILED';

export class ModelAttemptDiagnosticsWriterError extends Error {
  override readonly name = 'ModelAttemptDiagnosticsWriterError';
  readonly code: ModelAttemptDiagnosticsWriterErrorCode;

  constructor(code: ModelAttemptDiagnosticsWriterErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface ModelAttemptDiagnosticsWriter {
  append(diagnostic: ModelAttemptDiagnostic): Promise<void>;
  close(): Promise<void>;
}

export async function createModelAttemptDiagnosticsWriter(
  path: string,
): Promise<ModelAttemptDiagnosticsWriter> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx');
  } catch {
    throw new ModelAttemptDiagnosticsWriterError('MODEL_DIAGNOSTIC_WRITE_FAILED');
  }

  let closed = false;
  let appendInProgress = false;
  return {
    async append(diagnostic) {
      const parsed = modelAttemptDiagnosticSchema.safeParse(diagnostic);
      if (!parsed.success) {
        throw new ModelAttemptDiagnosticsWriterError('MODEL_DIAGNOSTIC_INVALID');
      }
      if (closed || appendInProgress) {
        throw new ModelAttemptDiagnosticsWriterError('MODEL_DIAGNOSTIC_WRITE_FAILED');
      }
      appendInProgress = true;
      try {
        await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, 'utf8');
        await handle.sync();
      } catch {
        throw new ModelAttemptDiagnosticsWriterError('MODEL_DIAGNOSTIC_WRITE_FAILED');
      } finally {
        appendInProgress = false;
      }
    },
    async close() {
      if (closed) {
        return;
      }
      try {
        await handle.close();
        closed = true;
      } catch {
        throw new ModelAttemptDiagnosticsWriterError('MODEL_DIAGNOSTIC_WRITE_FAILED');
      }
    },
  };
}
