import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  ModelAdapterError,
  modelAdapterErrorCodes,
  modelRequestSchema,
  modelResponseSchema,
  type ModelRequest,
  type ModelResponse,
} from '../../src/core/model.js';

function roundTrip<T>(schema: ZodType<T>, value: T): T {
  return schema.parse(JSON.parse(JSON.stringify(value)) as unknown);
}

const request: ModelRequest = {
  schemaVersion: 1,
  sessionId: 'session-1',
  turnIndex: 0,
  inputMessage: 'Summarize the repository.',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 1024,
  },
};

describe('model contracts', () => {
  it('round-trips a model request', () => {
    expect(roundTrip(modelRequestSchema, request)).toEqual(request);
  });

  it('round-trips optional tool descriptions with JSON Schemas', () => {
    const requestWithTools: ModelRequest = {
      ...request,
      tools: [
        {
          schemaVersion: 1,
          name: 'repository.search',
          description: 'Search repository content',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      ],
    };

    expect(roundTrip(modelRequestSchema, requestWithTools)).toEqual(requestWithTools);
  });

  it('requires the request task and tool alias to match its Context view', () => {
    const tool = {
      schemaVersion: 1 as const,
      name: 'repository.search',
      description: 'Search repository content',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    };
    const requestWithContext: ModelRequest = {
      ...request,
      tools: [tool],
      context: {
        schemaVersion: 1,
        systemRules: ['Return one action.'],
        taskInput: request.inputMessage,
        visibleTools: [tool],
        recentTurns: [],
        observations: [],
        omittedTurnCount: 0,
        omittedObservationCount: 0,
      },
    };

    expect(modelRequestSchema.safeParse(requestWithContext).success).toBe(true);
    expect(
      modelRequestSchema.safeParse({
        ...requestWithContext,
        inputMessage: 'A different task',
        tools: [],
      }).success,
    ).toBe(false);
  });

  it('round-trips a JSON-safe model response', () => {
    const response: ModelResponse = {
      schemaVersion: 1,
      output: {
        schemaVersion: 1,
        type: 'final_answer',
        content: { summary: 'Done' },
      },
    };

    expect(roundTrip(modelResponseSchema, response)).toEqual(response);
  });

  it.each([
    {
      name: 'unknown request field',
      schema: modelRequestSchema,
      value: { ...request, debug: true },
    },
    {
      name: 'invalid session identifier',
      schema: modelRequestSchema,
      value: { ...request, sessionId: 'contains spaces' },
    },
    {
      name: 'negative turn index',
      schema: modelRequestSchema,
      value: { ...request, turnIndex: -1 },
    },
    {
      name: 'empty input',
      schema: modelRequestSchema,
      value: { ...request, inputMessage: '' },
    },
    {
      name: 'unknown model parameter',
      schema: modelRequestSchema,
      value: { ...request, model: { ...request.model, apiKey: 'secret' } },
    },
    {
      name: 'unsupported schema version',
      schema: modelResponseSchema,
      value: { schemaVersion: 2, output: 'Done' },
    },
    {
      name: 'undefined output',
      schema: modelResponseSchema,
      value: { schemaVersion: 1, output: undefined },
    },
    {
      name: 'BigInt output',
      schema: modelResponseSchema,
      value: { schemaVersion: 1, output: 1n },
    },
    {
      name: 'function output',
      schema: modelResponseSchema,
      value: { schemaVersion: 1, output: () => undefined },
    },
    {
      name: 'non-finite output',
      schema: modelResponseSchema,
      value: { schemaVersion: 1, output: Number.POSITIVE_INFINITY },
    },
  ])('rejects $name', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects cyclic response output', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      modelResponseSchema.safeParse({
        schemaVersion: 1,
        output: cyclic,
      }).success,
    ).toBe(false);
  });
});

describe('ModelAdapterError', () => {
  it.each(modelAdapterErrorCodes)('exposes stable code and message for %s', (code) => {
    const sensitiveCause = new Error('api-key=do-not-expose');
    const error = new ModelAdapterError(code, { cause: sensitiveCause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ModelAdapterError');
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('do-not-expose');
    expect(error.cause).toBe(sensitiveCause);
  });
});
