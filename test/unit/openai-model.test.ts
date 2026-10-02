import { describe, expect, it, vi } from 'vitest';

import { OpenAIModelAdapter } from '../../src/core/openai-model.js';
import type { ModelRequest } from '../../src/core/model.js';
import { runModelAdapterContract } from './model-adapter-contract.js';

const request: ModelRequest = {
  schemaVersion: 1,
  sessionId: 'openai-test',
  turnIndex: 0,
  inputMessage: 'Return a final answer.',
  model: {
    provider: 'openai',
    name: 'gpt-test',
    temperature: 0,
    maxOutputTokens: 128,
  },
};

const createContractAdapter = (): OpenAIModelAdapter =>
  new OpenAIModelAdapter({
    apiKey: 'contract-secret',
    fetch: vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output_text: JSON.stringify({
          schemaVersion: 1,
          type: 'final_answer',
          content: 'contract-ok',
        }),
      }),
    ),
  });

runModelAdapterContract('OpenAIModelAdapter with injected transport', {
  request,
  createRespondingAdapter: createContractAdapter,
  createWaitingAdapter: createContractAdapter,
});

describe('OpenAIModelAdapter', () => {
  it('normalizes a Responses API payload', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  schemaVersion: 1,
                  type: 'final_answer',
                  content: 'Done',
                }),
              },
            ],
          },
        ],
      }),
    );
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      endpoint: 'https://example.test/responses',
      fetch: fetchMock,
    });

    const response = await adapter.complete(request, {
      signal: new AbortController().signal,
    });

    expect(response).toEqual({
      schemaVersion: 1,
      output: {
        schemaVersion: 1,
        type: 'final_answer',
        content: 'Done',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/responses',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
      }),
    );
    const callOptions = fetchMock.mock.calls[0]?.[1];
    expect(callOptions?.body).toEqual(expect.any(String));
    expect(callOptions?.body as string).not.toContain('test-secret');
  });

  it('accepts the top-level output_text convenience field', async () => {
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            type: 'final_answer',
            content: 'Done',
          }),
        }),
      ),
    });

    await expect(
      adapter.complete(request, {
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      output: { type: 'final_answer' },
    });
  });

  it('maps a context view in system, task, and evidence priority order', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output_text: JSON.stringify({
          schemaVersion: 1,
          type: 'final_answer',
          content: 'Done',
        }),
      }),
    );
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      fetch: fetchMock,
    });
    const observations = [
      {
        schemaVersion: 1 as const,
        type: 'tool_result' as const,
        callId: 'call-1',
        toolName: 'repository.search',
        data: { matches: ['runtime.ts'] },
        truncated: false,
        durationMs: 5,
      },
    ];

    await adapter.complete(
      {
        ...request,
        turnIndex: 1,
        context: {
          schemaVersion: 1,
          systemRules: ['Keep the result structured.'],
          taskInput: 'Use the tool evidence.',
          recentTurns: [],
          observations: [
            {
              sourceTurnIndex: 0,
              callId: 'call-1',
              toolName: 'repository.search',
              truncated: false,
              observation: observations[0]!,
            },
          ],
          omittedTurnCount: 0,
          omittedObservationCount: 0,
        },
      },
      { signal: new AbortController().signal },
    );

    const callOptions = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(callOptions?.body as string) as unknown;
    expect(body).toMatchObject({
      input: [
        {
          role: 'developer',
          content: 'Keep the result structured.',
        },
        {
          role: 'user',
          content: 'Use the tool evidence.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            schemaVersion: 1,
            recentTurns: [],
            observations: [
              {
                sourceTurnIndex: 0,
                callId: 'call-1',
                toolName: 'repository.search',
                truncated: false,
                observation: observations[0],
              },
            ],
            omittedTurnCount: 0,
            omittedObservationCount: 0,
          }),
        },
      ],
    });
  });

  it('maps HTTP failures without exposing the credential', async () => {
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('provider details', { status: 401 })),
    });

    const call = adapter.complete(request, {
      signal: new AbortController().signal,
    });

    await expect(call).rejects.toMatchObject({
      code: 'MODEL_CALL_FAILED',
      message: 'The model call failed',
    });
    await expect(call).rejects.not.toThrow('test-secret');
  });

  it('maps invalid JSON output to a response error', async () => {
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ output_text: 'not-json' })),
    });

    await expect(
      adapter.complete(request, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_INVALID',
    });
  });

  it('does not call fetch when already aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new OpenAIModelAdapter({
      apiKey: 'test-secret',
      fetch: fetchMock,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.complete(request, { signal: controller.signal })).rejects.toMatchObject({
      code: 'MODEL_CALL_ABORTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
