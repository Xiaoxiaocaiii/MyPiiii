import { z } from 'zod';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const repoQaInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(4_000),
});

export type RepoQaInput = z.infer<typeof repoQaInputSchema>;

export const repoQaOutputSchema = z.strictObject({
  answer: z.string().trim().min(1).max(16_000),
});

export type RepoQaOutput = z.infer<typeof repoQaOutputSchema>;

export const repoQaScenarioSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.literal('repo-qa'),
  version: identifierSchema,
  allowedTools: z.array(identifierSchema),
});

export type RepoQaScenario = z.infer<typeof repoQaScenarioSchema>;

export type ScenarioErrorCode =
  'SCENARIO_INPUT_INVALID' | 'SCENARIO_OUTPUT_INVALID' | 'SCENARIO_TOOL_NOT_ALLOWED';

const errorMessages: Record<ScenarioErrorCode, string> = {
  SCENARIO_INPUT_INVALID: 'The scenario input is invalid',
  SCENARIO_OUTPUT_INVALID: 'The scenario output is invalid',
  SCENARIO_TOOL_NOT_ALLOWED: 'The requested tool is not allowed for this scenario',
};

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
  readonly code: ScenarioErrorCode;

  constructor(code: ScenarioErrorCode) {
    super(errorMessages[code]);
    this.code = code;
  }
}

export const repoQaScenario: RepoQaScenario = {
  schemaVersion: 1,
  scenarioId: 'repo-qa',
  version: 'v1',
  allowedTools: ['project.summary', 'repository.search'],
};

const allowedTools = new Set(repoQaScenario.allowedTools);

export function adaptRepoQaInput(value: unknown): string {
  const result = repoQaInputSchema.safeParse(value);
  if (!result.success) {
    throw new ScenarioError('SCENARIO_INPUT_INVALID');
  }

  return `Repository question:\n${result.data.question}`;
}

export function parseRepoQaOutput(value: unknown): RepoQaOutput {
  const result = repoQaOutputSchema.safeParse(value);
  if (!result.success) {
    throw new ScenarioError('SCENARIO_OUTPUT_INVALID');
  }
  return result.data;
}

export function isRepoQaToolAllowed(toolName: string): boolean {
  const result = identifierSchema.safeParse(toolName);
  return result.success && allowedTools.has(result.data);
}

export function assertRepoQaToolAllowed(toolName: string): void {
  if (!isRepoQaToolAllowed(toolName)) {
    throw new ScenarioError('SCENARIO_TOOL_NOT_ALLOWED');
  }
}
