import { readFile } from 'node:fs/promises';

import { experimentConfigSchema, type ExperimentConfig } from './config.js';

export const configErrorCodes = {
  notFound: 'CONFIG_NOT_FOUND',
  parseError: 'CONFIG_PARSE_ERROR',
  validationError: 'CONFIG_VALIDATION_ERROR',
} as const;

export type ConfigErrorCode = (typeof configErrorCodes)[keyof typeof configErrorCodes];

export class ConfigError extends Error {
  public readonly code: ConfigErrorCode;

  public constructor(code: ConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export interface LoadExperimentConfigOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyEnvironment(source: unknown, env: NodeJS.ProcessEnv): unknown {
  if (env.ARTIFACTS_DIR === undefined || !isRecord(source)) {
    return source;
  }

  const artifacts = source.artifacts;
  if (artifacts !== undefined && !isRecord(artifacts)) {
    return source;
  }

  return {
    ...source,
    artifacts: {
      ...(artifacts ?? {}),
      directory: env.ARTIFACTS_DIR,
    },
  };
}

function formatValidationMessage(issues: readonly { path: PropertyKey[]; code: string }[]): string {
  const details = issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}:${issue.code}`)
    .join(', ');

  return `Configuration validation failed: ${details}`;
}

export async function loadExperimentConfig({
  configPath,
  env = process.env,
}: LoadExperimentConfigOptions): Promise<ExperimentConfig> {
  let contents: string;

  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    throw new ConfigError(
      configErrorCodes.notFound,
      `Configuration file could not be read: ${configPath}`,
      { cause: error },
    );
  }

  let source: unknown;

  try {
    source = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new ConfigError(
      configErrorCodes.parseError,
      `Configuration file is not valid JSON: ${configPath}`,
      { cause: error },
    );
  }

  const result = experimentConfigSchema.safeParse(applyEnvironment(source, env));
  if (!result.success) {
    throw new ConfigError(
      configErrorCodes.validationError,
      formatValidationMessage(result.error.issues),
      { cause: result.error },
    );
  }

  return result.data;
}
