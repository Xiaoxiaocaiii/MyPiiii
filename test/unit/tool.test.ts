import { describe, expect, it } from 'vitest';

import {
  ToolError,
  toolDefinitionMetadataSchema,
  toolErrorCodeSchema,
  toolErrorCodes,
} from '../../src/core/tool.js';

const metadata = {
  schemaVersion: 1,
  name: 'repository.search',
  description: 'Search repository content',
  timeoutMs: 1_000,
  sideEffect: 'none',
  allowedScenarios: ['repo-qa'],
} as const;

describe('tool definition metadata contract', () => {
  it('parses versioned tool metadata', () => {
    expect(toolDefinitionMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it.each([
    { ...metadata, schemaVersion: 2 },
    { ...metadata, name: 'invalid tool name' },
    { ...metadata, description: ' ' },
    { ...metadata, timeoutMs: 0 },
    { ...metadata, sideEffect: 'admin' },
    { ...metadata, allowedScenarios: [] },
    { ...metadata, allowedScenarios: ['repo-qa', 'repo-qa'] },
    { ...metadata, unknownField: true },
  ])('rejects invalid metadata %#', (value) => {
    expect(toolDefinitionMetadataSchema.safeParse(value).success).toBe(false);
  });
});

describe('tool error contract', () => {
  it('accepts every stable error code and rejects unknown codes', () => {
    for (const code of toolErrorCodes) {
      expect(toolErrorCodeSchema.parse(code)).toBe(code);
    }

    expect(toolErrorCodeSchema.safeParse('RAW_TOOL_FAILURE').success).toBe(false);
  });

  it.each([
    ['TOOL_NOT_FOUND', 'The requested tool is not available'],
    ['INPUT_INVALID', 'The tool input is invalid'],
    ['PERMISSION_DENIED', 'The tool call is not permitted'],
    ['TIMEOUT', 'The tool call timed out'],
    ['EXECUTION_FAILED', 'The tool execution failed'],
    ['OUTPUT_INVALID', 'The tool returned an invalid output'],
  ] as const)('uses a safe message for %s', (code, message) => {
    const error = new ToolError(code, {
      cause: new Error('token=private raw input and output'),
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolError');
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.message).not.toContain('private');
    expect(JSON.stringify(error)).not.toContain('private');
  });
});
