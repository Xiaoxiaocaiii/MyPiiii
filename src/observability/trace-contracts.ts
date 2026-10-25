import { z } from 'zod';

import { experimentConfigSchema } from '../core/config.js';
import { modelContextViewSchema } from '../core/context-window.js';
import { jsonValueSchema, sessionSchema, turnSchema, type JsonValue } from '../core/contracts.js';
import { modelRequestSchema, modelResponseSchema } from '../core/model.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const artifactRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !path.startsWith('/') &&
      !path.includes(':') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Expected a normalized relative artifact path',
  );

const sensitiveFieldNames = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'credentials',
  'password',
  'privatekey',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'token',
]);

function normalizedFieldName(field: string): string {
  return field.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function findSensitiveField(
  value: JsonValue,
  path: readonly PropertyKey[] = [],
): PropertyKey[] | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findSensitiveField(child, [...path, index]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  for (const [field, child] of Object.entries(value)) {
    const fieldPath = [...path, field];
    if (sensitiveFieldNames.has(normalizedFieldName(field))) {
      return fieldPath;
    }

    const found = findSensitiveField(child, fieldPath);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function rejectSensitiveFields(value: unknown, context: z.RefinementCtx): void {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }

  const sensitivePath = findSensitiveField(parsed.data);
  if (sensitivePath !== null) {
    context.addIssue({
      code: 'custom',
      message: 'Sensitive fields are not allowed in persisted observability data',
      path: sensitivePath,
    });
  }
}

function hasRedactedArguments(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return true;
  }
  if (value['type'] !== 'tool_call') {
    return true;
  }

  const args = value['args'];
  return (
    args !== null &&
    !Array.isArray(args) &&
    typeof args === 'object' &&
    Object.keys(args).length === 1 &&
    args['redacted'] === true
  );
}

export const persistedJsonValueSchema = jsonValueSchema.superRefine(rejectSensitiveFields);

const persistedModelRequestSchema = modelRequestSchema.superRefine(rejectSensitiveFields);
const persistedModelResponseSchema = modelResponseSchema.superRefine((response, context) => {
  rejectSensitiveFields(response, context);
  if (!hasRedactedArguments(response.output)) {
    context.addIssue({
      code: 'custom',
      message: 'Tool arguments must be redacted before persistence',
      path: ['output', 'args'],
    });
  }
});
const persistedContextViewSchema = modelContextViewSchema.superRefine(rejectSensitiveFields);
const persistedTurnSchema = turnSchema.superRefine((turn, context) => {
  rejectSensitiveFields(turn, context);
  if (turn.action?.type === 'tool_call' && !hasRedactedArguments(turn.action)) {
    context.addIssue({
      code: 'custom',
      message: 'Tool arguments must be redacted before persistence',
      path: ['action', 'args'],
    });
  }
  if (turn.modelResponse !== undefined && !hasRedactedArguments(turn.modelResponse)) {
    context.addIssue({
      code: 'custom',
      message: 'Tool arguments must be redacted before persistence',
      path: ['modelResponse', 'args'],
    });
  }
});

const traceEventEnvelopeShape = {
  schemaVersion: z.literal(1),
  eventId: identifierSchema,
  sessionId: sessionSchema.shape.sessionId,
  turnIndex: z.number().int().nonnegative().nullable(),
  sequence: z.number().int().nonnegative(),
  timestamp: timestampSchema,
  durationMs: z.number().nonnegative().optional(),
  artifactRefs: z.array(artifactRelativePathSchema).optional(),
};

const modelIdentitySchema = z.strictObject({
  provider: experimentConfigSchema.shape.model.shape.provider,
  name: experimentConfigSchema.shape.model.shape.name,
});

const redactedArgumentsSchema = z.strictObject({
  redacted: z.literal(true),
});

const toolResultPayloadSchema = z.strictObject({
  callId: identifierSchema,
  toolName: identifierSchema,
  data: persistedJsonValueSchema,
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});

const toolFailurePayloadSchema = z.strictObject({
  callId: identifierSchema,
  toolName: identifierSchema,
  code: identifierSchema,
  message: z.string().trim().min(1),
  retryable: z.boolean(),
  durationMs: z.number().nonnegative(),
});

export const traceEventSchema = z.discriminatedUnion('eventType', [
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('session.started'),
    payload: z.strictObject({
      configId: experimentConfigSchema.shape.configId,
      scenarioId: experimentConfigSchema.shape.scenarioId,
      model: modelIdentitySchema,
      inputMessage: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('context.built'),
    payload: z.strictObject({
      context: persistedContextViewSchema,
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('model.requested'),
    payload: z.strictObject({
      request: persistedModelRequestSchema,
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('model.responded'),
    payload: z.strictObject({
      response: persistedModelResponseSchema,
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('tool.requested'),
    payload: z.strictObject({
      callId: identifierSchema,
      toolName: identifierSchema,
      args: redactedArgumentsSchema,
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('tool.completed'),
    payload: toolResultPayloadSchema,
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('tool.failed'),
    payload: toolFailurePayloadSchema,
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('turn.completed'),
    payload: z.strictObject({
      turn: persistedTurnSchema,
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('session.completed'),
    payload: z.strictObject({
      finalOutput: persistedJsonValueSchema,
      turnCount: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    ...traceEventEnvelopeShape,
    eventType: z.literal('session.failed'),
    payload: z.strictObject({
      error: z.strictObject({
        code: identifierSchema,
        message: z.string().trim().min(1),
        cause: z
          .strictObject({
            name: identifierSchema,
            code: identifierSchema.optional(),
          })
          .optional(),
      }),
      turnCount: z.number().int().nonnegative(),
    }),
  }),
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceEventType = TraceEvent['eventType'];

export const runArtifactDescriptorSchema = z.strictObject({
  path: artifactRelativePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

export const runProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceSnapshot: z.strictObject({
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    files: z
      .array(
        z.strictObject({
          path: artifactRelativePathSchema,
          sha256: sha256Schema,
        }),
      )
      .min(1),
  }),
  redaction: z.strictObject({
    schemaVersion: z.literal(1),
    toolCallArguments: z.literal('redacted'),
    sensitiveFields: z.literal('rejected'),
    arbitraryText: z.literal('not_scanned'),
  }),
});

export type RunProvenance = z.infer<typeof runProvenanceSchema>;

export const runManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    traceSchemaVersion: z.literal(1),
    sessionId: sessionSchema.shape.sessionId,
    configId: experimentConfigSchema.shape.configId,
    scenarioId: experimentConfigSchema.shape.scenarioId,
    model: modelIdentitySchema,
    status: z.enum(['completed', 'failed']),
    createdAt: timestampSchema,
    completedAt: timestampSchema,
    configSummary: z.strictObject({
      schemaVersion: z.literal(1),
      runtime: experimentConfigSchema.shape.runtime,
      context: experimentConfigSchema.shape.context,
      tools: experimentConfigSchema.shape.tools,
    }),
    provenance: runProvenanceSchema.optional(),
    artifacts: z.strictObject({
      trace: runArtifactDescriptorSchema,
      finalOutput: runArtifactDescriptorSchema,
    }),
  })
  .superRefine((manifest, context) => {
    rejectSensitiveFields(manifest, context);
    if (Date.parse(manifest.completedAt) < Date.parse(manifest.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Completion time must not precede creation time',
        path: ['completedAt'],
      });
    }
  });

export type RunArtifactDescriptor = z.infer<typeof runArtifactDescriptorSchema>;
export type RunManifest = z.infer<typeof runManifestSchema>;

export const observabilityContractErrorCodeSchema = z.enum([
  'TRACE_EVENT_INVALID',
  'RUN_MANIFEST_INVALID',
]);

export type ObservabilityContractErrorCode = z.infer<typeof observabilityContractErrorCodeSchema>;

const contractErrorMessages: Record<ObservabilityContractErrorCode, string> = {
  TRACE_EVENT_INVALID: 'The trace event is invalid',
  RUN_MANIFEST_INVALID: 'The run manifest is invalid',
};

export class ObservabilityContractError extends Error {
  override readonly name = 'ObservabilityContractError';
  readonly code: ObservabilityContractErrorCode;

  constructor(code: ObservabilityContractErrorCode) {
    super(contractErrorMessages[code]);
    this.code = code;
  }
}

export function parseTraceEvent(value: unknown): TraceEvent {
  const result = traceEventSchema.safeParse(value);
  if (!result.success) {
    throw new ObservabilityContractError('TRACE_EVENT_INVALID');
  }
  return result.data;
}

export function parseRunManifest(value: unknown): RunManifest {
  const result = runManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ObservabilityContractError('RUN_MANIFEST_INVALID');
  }
  return result.data;
}
