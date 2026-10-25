import { describe, expect, it, vi } from 'vitest';

import { DeepSeekModelAdapter, type ModelRequest } from '../../src/index.js';
import { experimentConfigSchema } from '../../src/core/config.js';
import { runAgent } from '../../src/core/runtime.js';
import { runModelAdapterContract } from './model-adapter-contract.js';

const finalAction = {
  schemaVersion: 1,
  type: 'final_answer',
  content: 'The answer is supported by the inspected source.',
};

const firstToolAction = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-1',
  toolName: 'repo.search_source',
  args: { query: 'brace } and "quote"' },
};

const secondToolAction = {
  schemaVersion: 1,
  type: 'tool_call',
  callId: 'call-2',
  toolName: 'repo.list_files',
  args: {},
};

const request: ModelRequest = {
  schemaVersion: 1,
  sessionId: 'deepseek-test',
  turnIndex: 0,
  inputMessage: 'Explain the behavior.',
  model: {
    provider: 'deepseek',
    name: 'deepseek-flash',
    temperature: 0,
    maxOutputTokens: 256,
  },
};

const respondingAdapter = (): DeepSeekModelAdapter =>
  new DeepSeekModelAdapter({
    apiKey: 'contract-secret',
    fetch: vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(finalAction) } }],
      }),
    ),
  });

runModelAdapterContract('DeepSeekModelAdapter with injected transport', {
  request,
  createRespondingAdapter: respondingAdapter,
  createWaitingAdapter: respondingAdapter,
});

describe('DeepSeekModelAdapter', () => {
  it('maps a MyPiiii request to Chat Completions JSON Output without native tools', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(finalAction) } }],
      }),
    );
    const tools = [
      {
        schemaVersion: 1 as const,
        name: 'repo.search_source',
        description: 'Search the permitted pilot source files.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      fetch: fetchMock,
    });

    await expect(
      adapter.complete({ ...request, tools }, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      schemaVersion: 1,
      output: finalAction,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(options?.body as string) as {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
    };
    expect(body.model).toBe('deepseek-flash');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('Available tools for this request');
    expect(body.messages[0]?.content).toContain(JSON.stringify(tools));
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: 'Explain the behavior.',
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('test-secret');
  });

  it('keeps the first valid action when the model concatenates multiple JSON actions', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: `${JSON.stringify(firstToolAction)}\n\n${JSON.stringify(secondToolAction)}`,
            },
          },
        ],
      }),
    );
    const adapter = new DeepSeekModelAdapter({ apiKey: 'test-secret', fetch: fetchMock });

    await expect(
      adapter.complete(request, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      schemaVersion: 1,
      output: firstToolAction,
    });
  });

  it('accepts a complete leading action when the provider truncates trailing output', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: `${JSON.stringify(firstToolAction)}\n{"schemaVersion":1,"type":`,
            },
          },
        ],
      }),
    );
    const adapter = new DeepSeekModelAdapter({ apiKey: 'test-secret', fetch: fetchMock });

    await expect(
      adapter.complete(request, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      schemaVersion: 1,
      output: firstToolAction,
    });
  });

  it('maps the structured Context view to system and user messages', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(finalAction) } }],
      }),
    );
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      fetch: fetchMock,
    });
    const tools = [
      {
        schemaVersion: 1 as const,
        name: 'repo.search_source',
        description: 'Search permitted source files.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];

    await adapter.complete(
      {
        ...request,
        turnIndex: 1,
        tools,
        context: {
          schemaVersion: 1,
          systemRules: [
            'Use only supplied evidence.',
            'Output one JSON object only. Never return multiple JSON objects, newline-delimited JSON, Markdown, or prose. For tool use, choose exactly one tool_call and wait for its observation before requesting another tool.',
            'Example final_answer JSON: {"schemaVersion":1,"type":"final_answer","content":"answer"}',
            'Example tool_call JSON: {"schemaVersion":1,"type":"tool_call","callId":"call-1","toolName":"repo.search_source","args":{"query":"ContextBudgetError"}}',
          ],
          taskInput: 'Inspect the context behavior.',
          visibleTools: tools,
          recentTurns: [],
          observations: [],
          omittedTurnCount: 1,
          omittedObservationCount: 0,
          omissionReasons: {
            duplicateTurns: 0,
            recentTurnLimit: 1,
            characterBudgetTurns: 0,
            duplicateObservations: 0,
            characterBudgetObservations: 0,
          },
          truncationReasons: {
            toolOutputLimitObservations: 0,
            contextCharacterLimitObservations: 0,
          },
        },
      },
      { signal: new AbortController().signal },
    );

    const options = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(options?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('Use only supplied evidence.');
    expect(body.messages[0]?.content).toContain(
      'Output one JSON object only. Never return multiple JSON objects, newline-delimited JSON, Markdown, or prose. For tool use, choose exactly one tool_call and wait for its observation before requesting another tool.',
    );
    expect(body.messages[0]?.content).toContain(
      'Example final_answer JSON: {"schemaVersion":1,"type":"final_answer","content":"answer"}',
    );
    expect(body.messages[0]?.content).toContain(
      'Example tool_call JSON: {"schemaVersion":1,"type":"tool_call","callId":"call-1","toolName":"repo.search_source","args":{"query":"ContextBudgetError"}}',
    );
    expect(body.messages[1]?.role).toBe('user');
    expect(JSON.parse(body.messages[1]?.content ?? '')).toEqual({
      schemaVersion: 1,
      taskInput: 'Inspect the context behavior.',
      visibleTools: tools,
      recentTurns: [],
      observations: [],
      omittedTurnCount: 1,
      omittedObservationCount: 0,
      omissionReasons: {
        duplicateTurns: 0,
        recentTurnLimit: 1,
        characterBudgetTurns: 0,
        duplicateObservations: 0,
        characterBudgetObservations: 0,
      },
      truncationReasons: {
        toolOutputLimitObservations: 0,
        contextCharacterLimitObservations: 0,
      },
    });
  });

  it('normalizes HTTP errors without retaining provider bodies or the key', async () => {
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'private-test-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private-test-key: invalid credentials', { status: 401 })),
    });

    const call = adapter.complete(request, { signal: new AbortController().signal });
    await expect(call).rejects.toMatchObject({
      name: 'ModelAdapterError',
      code: 'MODEL_CALL_FAILED',
      message: 'The model call failed',
    });
    await expect(call).rejects.not.toThrow('private-test-key');
  });

  it.each([
    {
      label: 'invalid JSON',
      body: { choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }] },
    },
    { label: 'missing choices', body: { choices: [] } },
    {
      label: 'truncated output',
      body: { choices: [{ finish_reason: 'length', message: { content: '{"type":' } }] },
    },
    {
      label: 'prose before a valid action',
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: `Additional text\n${JSON.stringify(firstToolAction)}`,
            },
          },
        ],
      },
    },
    {
      label: 'unsupported native tool call',
      body: {
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [] } }],
      },
    },
  ])('rejects $label as an invalid model response', async ({ body }) => {
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
    });

    await expect(
      adapter.complete(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_INVALID',
    });
  });

  it('does not send a request when the signal is already aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new DeepSeekModelAdapter({ apiKey: 'test-secret', fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.complete(request, { signal: controller.signal })).rejects.toMatchObject({
      code: 'MODEL_CALL_ABORTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an in-flight client abort to MODEL_CALL_ABORTED', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const adapter = new DeepSeekModelAdapter({ apiKey: 'test-secret', fetch: fetchMock });
    const controller = new AbortController();
    const call = adapter.complete(request, { signal: controller.signal });
    controller.abort();

    await expect(call).rejects.toMatchObject({
      code: 'MODEL_CALL_ABORTED',
    });
  });

  it('maps the Runtime timeout to a failed run and aborts the pending fetch', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      );
      const adapter = new DeepSeekModelAdapter({
        apiKey: 'test-secret',
        fetch: fetchMock,
      });
      const config = experimentConfigSchema.parse({
        schemaVersion: 1,
        configId: 'deepseek-timeout-test',
        scenarioId: 'repo-qa',
        model: request.model,
        runtime: { maxTurns: 1, timeoutMs: 25 },
        tools: { enabled: [] },
      });

      const run = runAgent(
        {
          schemaVersion: 1,
          sessionId: 'deepseek-timeout-test',
          inputMessage: 'Return a final answer.',
          config,
        },
        adapter,
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(run).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'RUN_TIMEOUT' },
      });
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
