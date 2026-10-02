import { z } from 'zod';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const experimentConfigSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  configId: identifierSchema,
  scenarioId: identifierSchema,
  model: z.strictObject({
    provider: identifierSchema,
    name: z.string().trim().min(1).max(256),
    temperature: z.number().min(0).max(2).default(0),
    maxOutputTokens: z.number().int().positive().default(1024),
  }),
  runtime: z
    .strictObject({
      maxTurns: z.number().int().positive().default(8),
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .default({
      maxTurns: 8,
      timeoutMs: 120_000,
    }),
  context: z
    .strictObject({
      maxCharacters: z.number().int().positive().default(16_000),
      recentTurns: z.number().int().nonnegative().default(4),
      observationMaxCharacters: z.number().int().positive().default(2_000),
    })
    .optional(),
  tools: z
    .strictObject({
      enabled: z.array(identifierSchema).default([]),
    })
    .default({
      enabled: [],
    }),
  artifacts: z
    .strictObject({
      directory: z.string().trim().min(1).default('./artifacts'),
    })
    .default({
      directory: './artifacts',
    }),
});

export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;
