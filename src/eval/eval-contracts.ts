import { z } from 'zod';

import {
  artifactRelativePathSchema,
  persistedJsonValueSchema,
} from '../observability/trace-contracts.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const versionSchema = identifierSchema;

export const evalScoringRuleTypeSchema = z.enum([
  'exact_match',
  'schema_valid',
  'required_fields_present',
  'expected_tool_used',
  'forbidden_tool_not_used',
  'latency_ms',
  'tool_error_count',
  'token_usage',
  'cost',
]);

export type EvalScoringRuleType = z.infer<typeof evalScoringRuleTypeSchema>;
export const evalScoringRuleSchema = z.strictObject({
  ruleId: identifierSchema,
  type: evalScoringRuleTypeSchema,
  parameters: persistedJsonValueSchema.optional(),
});

export type EvalScoringRule = z.infer<typeof evalScoringRuleSchema>;

export const evalCaseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    caseId: identifierSchema,
    input: persistedJsonValueSchema,
    expected: persistedJsonValueSchema.optional(),
    tags: z.array(identifierSchema),
    scoringRules: z.array(evalScoringRuleSchema).min(1),
  })
  .superRefine((value, context) => {
    const ruleIds = new Set<string>();
    value.scoringRules.forEach((rule, index) => {
      if (ruleIds.has(rule.ruleId)) {
        context.addIssue({
          code: 'custom',
          message: 'Scoring rule IDs must be unique within an evaluation case',
          path: ['scoringRules', index, 'ruleId'],
        });
      }
      ruleIds.add(rule.ruleId);
    });
  });

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalDatasetSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    datasetId: identifierSchema,
    version: versionSchema,
    scenarioId: identifierSchema,
    scenarioVersion: versionSchema,
    cases: z.array(evalCaseSchema).min(20).max(50),
  })
  .superRefine((value, context) => {
    const caseIds = new Set<string>();
    value.cases.forEach((evalCase, index) => {
      if (caseIds.has(evalCase.caseId)) {
        context.addIssue({
          code: 'custom',
          message: 'Case IDs must be unique within an evaluation dataset',
          path: ['cases', index, 'caseId'],
        });
      }
      caseIds.add(evalCase.caseId);
    });
  });

export type EvalDataset = z.infer<typeof evalDatasetSchema>;

export const evalExperimentIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: identifierSchema,
  datasetId: identifierSchema,
  datasetVersion: versionSchema,
  scenarioId: identifierSchema,
  scenarioVersion: versionSchema,
  configId: identifierSchema,
  configVersion: versionSchema,
  scoringVersion: versionSchema,
});

export type EvalExperimentIdentity = z.infer<typeof evalExperimentIdentitySchema>;

export const evalRuleResultSchema = z.strictObject({
  ruleId: identifierSchema,
  passed: z.boolean(),
  score: z.number().min(0).max(1),
});

export type EvalRuleResult = z.infer<typeof evalRuleResultSchema>;

export const evalScoreResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  rules: z.array(evalRuleResultSchema),
});

export type EvalScoreResult = z.infer<typeof evalScoreResultSchema>;

export const evalFailureCategorySchema = z.enum([
  'model',
  'tool',
  'context',
  'runtime',
  'storage',
  'trace_integrity',
  'unknown',
]);

export type EvalFailureCategory = z.infer<typeof evalFailureCategorySchema>;
export const evalSampleResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: identifierSchema,
  sessionId: identifierSchema,
  tracePath: artifactRelativePathSchema,
  status: z.enum(['completed', 'failed']),
  score: evalScoreResultSchema.optional(),
  failureCode: identifierSchema.optional(),
  failureCategory: evalFailureCategorySchema.optional(),
});

export type EvalSampleResult = z.infer<typeof evalSampleResultSchema>;

export type EvalContractErrorCode =
  | 'EVAL_CASE_INVALID'
  | 'EVAL_DATASET_INVALID'
  | 'EVAL_EXPERIMENT_INVALID'
  | 'EVAL_SAMPLE_INVALID'
  | 'EVAL_SCORE_INVALID';

const errorMessages: Record<EvalContractErrorCode, string> = {
  EVAL_CASE_INVALID: 'The evaluation case is invalid',
  EVAL_DATASET_INVALID: 'The evaluation dataset is invalid',
  EVAL_EXPERIMENT_INVALID: 'The evaluation experiment identity is invalid',
  EVAL_SAMPLE_INVALID: 'The evaluation sample result is invalid',
  EVAL_SCORE_INVALID: 'The evaluation score result is invalid',
};

export class EvalContractError extends Error {
  override readonly name = 'EvalContractError';
  readonly code: EvalContractErrorCode;

  constructor(code: EvalContractErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export function parseEvalCase(value: unknown): EvalCase {
  const result = evalCaseSchema.safeParse(value);
  if (!result.success) {
    throw new EvalContractError('EVAL_CASE_INVALID');
  }
  return result.data;
}

export function parseEvalDataset(value: unknown): EvalDataset {
  const result = evalDatasetSchema.safeParse(value);
  if (!result.success) {
    throw new EvalContractError('EVAL_DATASET_INVALID');
  }
  return result.data;
}

export function parseEvalExperimentIdentity(value: unknown): EvalExperimentIdentity {
  const result = evalExperimentIdentitySchema.safeParse(value);
  if (!result.success) {
    throw new EvalContractError('EVAL_EXPERIMENT_INVALID');
  }
  return result.data;
}

export function parseEvalScoreResult(value: unknown): EvalScoreResult {
  const result = evalScoreResultSchema.safeParse(value);
  if (!result.success) {
    throw new EvalContractError('EVAL_SCORE_INVALID');
  }
  return result.data;
}

export function parseEvalSampleResult(value: unknown): EvalSampleResult {
  const result = evalSampleResultSchema.safeParse(value);
  if (!result.success) {
    throw new EvalContractError('EVAL_SAMPLE_INVALID');
  }
  return result.data;
}
