import {
  ModelAdapterError,
  modelResponseSchema,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelRequest,
  type ModelResponse,
} from './model.js';

export interface OpenAIModelAdapterOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

interface OpenAIResponseBody {
  output_text?: unknown;
  output?: unknown;
}

const defaultEndpoint = 'https://api.openai.com/v1/responses';

export class OpenAIModelAdapter implements ModelAdapter {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAIModelAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? defaultEndpoint;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse> {
    if (options.signal.aborted) {
      throw new ModelAdapterError('MODEL_CALL_ABORTED', {
        cause: options.signal.reason,
      });
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model.name,
          input: buildInput(request),
          temperature: request.model.temperature,
          max_output_tokens: request.model.maxOutputTokens,
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new ModelAdapterError('MODEL_CALL_ABORTED', { cause: error });
      }
      throw new ModelAdapterError('MODEL_CALL_FAILED', { cause: error });
    }

    if (!response.ok) {
      throw new ModelAdapterError('MODEL_CALL_FAILED', {
        cause: new Error(`OpenAI HTTP status ${response.status}`),
      });
    }

    try {
      const body = (await response.json()) as OpenAIResponseBody;
      const outputText = extractOutputText(body);
      const output = JSON.parse(outputText) as unknown;
      return modelResponseSchema.parse({
        schemaVersion: 1,
        output,
      });
    } catch (error) {
      throw new ModelAdapterError('MODEL_RESPONSE_INVALID', { cause: error });
    }
  }
}

function buildInput(request: ModelRequest): Array<{ role: 'developer' | 'user'; content: string }> {
  if (request.context !== undefined) {
    const { systemRules, ...contextPayload } = request.context;
    return [
      {
        role: 'developer',
        content: systemRules.join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify(contextPayload),
      },
    ];
  }

  const toolInstructions = buildToolInstructions(request);
  return [
    {
      role: 'developer',
      content:
        toolInstructions === undefined
          ? 'Return only one JSON value representing the requested agent action.'
          : `Return only one JSON value representing the requested agent action.\n${toolInstructions}`,
    },
    {
      role: 'user',
      content: request.inputMessage,
    },
    ...(request.observations === undefined
      ? []
      : [
          {
            role: 'user' as const,
            content: JSON.stringify({
              type: 'tool_observations',
              observations: request.observations,
            }),
          },
        ]),
  ];
}

function buildToolInstructions(request: ModelRequest): string | undefined {
  if (request.tools === undefined || request.tools.length === 0) {
    return undefined;
  }

  return [
    'Available tools for this request. If calling a tool, return a tool_call action using an exact name and arguments matching its inputSchema JSON Schema.',
    JSON.stringify(request.tools),
  ].join('\n');
}

function extractOutputText(body: OpenAIResponseBody): string {
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }

  if (!Array.isArray(body.output)) {
    throw new Error('OpenAI response does not contain output text');
  }

  for (const item of body.output as unknown[]) {
    if (typeof item !== 'object' || item === null || !('content' in item)) {
      continue;
    }
    const content = (item as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content as unknown[]) {
      if (typeof part === 'object' && part !== null && 'text' in part) {
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') {
          return text;
        }
      }
    }
  }

  throw new Error('OpenAI response does not contain output text');
}
