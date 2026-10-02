import { z } from 'zod';

import { jsonValueSchema, type JsonValue } from './contracts.js';
import {
  ToolError,
  toolDefinitionMetadataSchema,
  type ToolDefinition,
  type ToolDefinitionMetadata,
} from './tool.js';

type RegisteredToolDefinition = ToolDefinition<unknown, JsonValue>;

export const toolDescriptionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: toolDefinitionMetadataSchema.shape.name,
  description: toolDefinitionMetadataSchema.shape.description,
  inputSchema: jsonValueSchema,
});

export type ToolDescription = z.infer<typeof toolDescriptionSchema>;

export const toolRegistryErrorCodeSchema = z.enum([
  'TOOL_DEFINITION_INVALID',
  'TOOL_NAME_CONFLICT',
]);

export type ToolRegistryErrorCode = z.infer<typeof toolRegistryErrorCodeSchema>;

const toolRegistryErrorMessages: Record<ToolRegistryErrorCode, string> = {
  TOOL_DEFINITION_INVALID: 'The tool definition is invalid',
  TOOL_NAME_CONFLICT: 'A tool with this name is already registered',
};

export class ToolRegistryError extends Error {
  override readonly name = 'ToolRegistryError';
  readonly code: ToolRegistryErrorCode;

  constructor(code: ToolRegistryErrorCode, options?: ErrorOptions) {
    super(toolRegistryErrorMessages[code], options);
    this.code = code;
  }
}

export class ToolRegistry {
  readonly #definitions = new Map<string, RegisteredToolDefinition>();

  constructor(definitions: readonly RegisteredToolDefinition[]) {
    for (const definition of definitions) {
      const metadata = parseMetadata(definition);
      if (this.#definitions.has(metadata.name)) {
        throw new ToolRegistryError('TOOL_NAME_CONFLICT');
      }

      this.#definitions.set(metadata.name, {
        ...definition,
        ...metadata,
      });
    }
  }

  resolve(name: string, scenarioId: string, enabledTools: readonly string[]) {
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new ToolError('TOOL_NOT_FOUND');
    }

    if (
      !enabledTools.includes(definition.name) ||
      !definition.allowedScenarios.includes(scenarioId)
    ) {
      throw new ToolError('PERMISSION_DENIED');
    }

    return definition;
  }

  listAvailable(scenarioId: string, enabledTools: readonly string[]) {
    const enabled = new Set(enabledTools);

    return [...this.#definitions.values()]
      .filter(
        (definition) =>
          enabled.has(definition.name) && definition.allowedScenarios.includes(scenarioId),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  describeAvailable(scenarioId: string, enabledTools: readonly string[]): ToolDescription[] {
    return this.listAvailable(scenarioId, enabledTools).map((definition) =>
      toolDescriptionSchema.parse({
        schemaVersion: 1,
        name: definition.name,
        description: definition.description,
        inputSchema: z.toJSONSchema(definition.inputSchema),
      }),
    );
  }
}

function parseMetadata(definition: RegisteredToolDefinition): ToolDefinitionMetadata {
  const result = toolDefinitionMetadataSchema.safeParse({
    schemaVersion: definition.schemaVersion,
    name: definition.name,
    description: definition.description,
    timeoutMs: definition.timeoutMs,
    sideEffect: definition.sideEffect,
    allowedScenarios: definition.allowedScenarios,
  });

  if (!result.success) {
    throw new ToolRegistryError('TOOL_DEFINITION_INVALID', { cause: result.error });
  }

  return result.data;
}
