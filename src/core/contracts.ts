import { z } from 'zod';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }

  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);

  return valid;
}

export const jsonValueSchema = z.custom<JsonValue>(isJsonValue, {
  message: 'Expected a JSON-serializable value',
});

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const timestampSchema = z.string().datetime({ offset: true });

export const agentActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('tool_call'),
    callId: idSchema,
    toolName: idSchema,
    args: jsonValueSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('final_answer'),
    content: jsonValueSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('invalid'),
    reason: z.string().trim().min(1),
    raw: jsonValueSchema,
  }),
]);

export type AgentAction = z.infer<typeof agentActionSchema>;

export const observationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('tool_result'),
    callId: idSchema,
    toolName: idSchema,
    data: jsonValueSchema,
    truncated: z.boolean().default(false),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('tool_error'),
    callId: idSchema,
    toolName: idSchema,
    code: idSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
    durationMs: z.number().nonnegative(),
  }),
]);

export type Observation = z.infer<typeof observationSchema>;

export const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: idSchema,
  scenarioId: idSchema,
  configId: idSchema,
  status: z.enum(['created', 'running', 'completed', 'failed']),
  createdAt: timestampSchema,
});

export type Session = z.infer<typeof sessionSchema>;

export const turnSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: idSchema,
  turnIndex: z.number().int().nonnegative(),
  inputMessage: z.string().min(1),
  modelResponse: jsonValueSchema.optional(),
  action: agentActionSchema.optional(),
  observations: z.array(observationSchema).default([]),
  stopReason: z.string().trim().min(1).optional(),
});

export type Turn = z.infer<typeof turnSchema>;
