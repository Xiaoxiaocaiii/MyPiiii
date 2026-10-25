import {
  ModelAdapterError,
  type ModelAttemptDiagnostic,
  modelResponseSchema,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelRequest,
  type ModelResponse,
} from './model.js';
import { agentActionSchema, type AgentAction } from './contracts.js';

export interface DeepSeekModelAdapterOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

const defaultEndpoint = 'https://api.deepseek.com/chat/completions';

type ResponseParseCategory = ModelAttemptDiagnostic['responseParseCategory'];

class DeepSeekResponseError extends Error {
  readonly category: Extract<
    ResponseParseCategory,
    | 'invalid_provider_response'
    | 'empty_content'
    | 'invalid_action_json'
    | 'invalid_response_schema'
  >;

  constructor(category: DeepSeekResponseError['category'], options?: ErrorOptions) {
    super(category, options);
    this.category = category;
  }
}

const actionInstructions = [
  'Return exactly one JSON object representing one MyPiiii agent action.',
  'Example final answer: {"schemaVersion":1,"type":"final_answer","content":"answer"}',
  'Example tool call: {"schemaVersion":1,"type":"tool_call","callId":"call-1","toolName":"repo.search_source","args":{"query":"ContextBudgetError"}}',
].join('\n');

export class DeepSeekModelAdapter implements ModelAdapter {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: DeepSeekModelAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? defaultEndpoint;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse> {
    const requestedAt = new Date();
    let httpStatus: number | null = null;
    let remoteModel: string | null = null;
    let finishReason: ModelAttemptDiagnostic['finishReason'] = null;
    let usage: ModelAttemptDiagnostic['usage'] = null;
    let responseParseCategory: ResponseParseCategory = 'invalid_provider_response';
    let actionSchemaValid: boolean | null = null;
    let responseValue: ModelResponse | undefined;
    let failureCode:
      'MODEL_CALL_FAILED' | 'MODEL_CALL_ABORTED' | 'MODEL_RESPONSE_INVALID' | undefined;

    if (options.signal.aborted) {
      responseParseCategory = 'cancelled';
      failureCode = 'MODEL_CALL_ABORTED';
    } else {
      let response: Response | undefined;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model.name,
            messages: buildMessages(request),
            temperature: request.model.temperature,
            max_tokens: request.model.maxOutputTokens,
            response_format: { type: 'json_object' },
          }),
          signal: options.signal,
        });
      } catch {
        responseParseCategory = options.signal.aborted ? 'cancelled' : 'transport_error';
        failureCode = options.signal.aborted ? 'MODEL_CALL_ABORTED' : 'MODEL_CALL_FAILED';
      }

      if (response !== undefined) {
        httpStatus = response.status;
        if (!response.ok) {
          responseParseCategory = 'http_error';
          failureCode = 'MODEL_CALL_FAILED';
        } else {
          let body: unknown;
          try {
            body = JSON.parse(await response.text()) as unknown;
          } catch {
            responseParseCategory = 'invalid_provider_json';
            failureCode = 'MODEL_RESPONSE_INVALID';
          }

          if (failureCode === undefined) {
            const metadata = extractProviderMetadata(body);
            remoteModel = metadata.remoteModel;
            finishReason = metadata.finishReason;
            usage = metadata.usage;
            try {
              const content = extractAssistantContent(body);
              const parsedOutput = parseAssistantOutput(content);
              const parsedResponse = modelResponseSchema.safeParse({
                schemaVersion: 1,
                output: parsedOutput.output,
              });
              if (!parsedResponse.success) {
                throw new DeepSeekResponseError('invalid_response_schema');
              }
              actionSchemaValid = agentActionSchema.safeParse(parsedOutput.output).success;
              responseParseCategory = parsedOutput.recovered ? 'json_parse_recovered' : 'accepted';
              responseValue = parsedResponse.data;
            } catch (error) {
              if (error instanceof DeepSeekResponseError) {
                responseParseCategory = error.category;
              } else {
                responseParseCategory = 'invalid_action_json';
              }
              failureCode = 'MODEL_RESPONSE_INVALID';
            }
          }
        }
      }
    }

    await options.onAttemptDiagnostic?.({
      schemaVersion: 1,
      sessionId: request.sessionId,
      turnIndex: request.turnIndex,
      modelName: request.model.name,
      requestedAt: requestedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - requestedAt.getTime()),
      httpStatus,
      remoteModel,
      finishReason,
      usage,
      costEstimate: {
        status: 'unknown',
        amountUsd: null,
        reason: 'pricing_not_frozen',
      },
      responseParseCategory,
      actionSchemaValid,
    });

    if (failureCode !== undefined) {
      throw new ModelAdapterError(failureCode);
    }
    if (responseValue === undefined) {
      throw new ModelAdapterError('MODEL_RESPONSE_INVALID');
    }
    return responseValue;
  }
}

function parseAssistantOutput(content: string): { output: unknown; recovered: boolean } {
  try {
    return { output: JSON.parse(content) as unknown, recovered: false };
  } catch (error) {
    const action = parseLeadingAction(content);
    if (action === undefined) {
      throw new DeepSeekResponseError('invalid_action_json', { cause: error });
    }

    // Runtime handles one action per turn; the model decides again after each observation.
    return { output: action, recovered: true };
  }
}

function parseLeadingAction(content: string): AgentAction | undefined {
  let start = 0;
  while (start < content.length && /\s/.test(content[start] ?? '')) {
    start += 1;
  }
  if (content[start] !== '{') {
    return undefined;
  }

  const end = findJsonObjectEnd(content, start);
  if (end === undefined) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(content.slice(start, end));
  } catch {
    return undefined;
  }
  const parsedAction = agentActionSchema.safeParse(value);
  if (!parsedAction.success) {
    return undefined;
  }

  return parsedAction.data;
}

function findJsonObjectEnd(content: string, start: number): number | undefined {
  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (character === undefined) {
      return undefined;
    }
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') {
      insideString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }

  return undefined;
}

function buildMessages(request: ModelRequest): ChatMessage[] {
  if (request.context !== undefined) {
    const { systemRules, ...contextPayload } = request.context;
    return [
      {
        role: 'system',
        content: systemRules.join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify(contextPayload),
      },
    ];
  }

  const toolInstructions = buildToolInstructions(request);
  const protocolInstructions = [
    actionInstructions,
    ...(toolInstructions === undefined ? [] : [toolInstructions]),
  ].join('\n');

  return [
    {
      role: 'system',
      content: protocolInstructions,
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

export function estimateDeepSeekInputTokenUpperBound(request: ModelRequest): number {
  const messages = buildMessages(request);
  const serializedMessageBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');

  // Bound tokenizer output by payload bytes and reserve generously for message framing.
  return serializedMessageBytes + messages.length * 4096;
}

function buildToolInstructions(request: ModelRequest): string | undefined {
  if (request.tools === undefined || request.tools.length === 0) {
    return undefined;
  }

  return [
    'Available tools for this request. If calling one, return a tool_call action using an exact name and arguments matching its inputSchema JSON Schema.',
    JSON.stringify(request.tools),
  ].join('\n');
}

function extractAssistantContent(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body['choices']) || body['choices'].length === 0) {
    throw new DeepSeekResponseError('invalid_provider_response');
  }
  const choice = body['choices'][0] as unknown;
  if (
    !isRecord(choice) ||
    (choice['finish_reason'] !== 'stop' && choice['finish_reason'] !== 'length') ||
    !isRecord(choice['message']) ||
    typeof choice['message']['content'] !== 'string'
  ) {
    throw new DeepSeekResponseError('invalid_provider_response');
  }
  const content = choice['message']['content'];
  if (content.trim().length === 0) {
    throw new DeepSeekResponseError('empty_content');
  }
  return content;
}

function extractProviderMetadata(body: unknown): {
  readonly remoteModel: string | null;
  readonly finishReason: ModelAttemptDiagnostic['finishReason'];
  readonly usage: ModelAttemptDiagnostic['usage'];
} {
  if (!isRecord(body)) {
    return { remoteModel: null, finishReason: null, usage: null };
  }
  const value = body;
  const remoteModel =
    typeof value['model'] === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value['model'])
      ? value['model']
      : null;
  const firstChoice: unknown = Array.isArray(value['choices'])
    ? (value['choices'] as unknown[])[0]
    : undefined;
  const rawFinishReason = isRecord(firstChoice) ? firstChoice['finish_reason'] : undefined;
  const finishReason =
    rawFinishReason === 'stop' || rawFinishReason === 'length'
      ? rawFinishReason
      : rawFinishReason === undefined || rawFinishReason === null
        ? null
        : 'other';
  const rawUsage = value['usage'];
  if (!isRecord(rawUsage)) {
    return { remoteModel, finishReason, usage: null };
  }
  const usage = rawUsage;
  const tokenCount = (key: string): number | null => {
    const count = usage[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  };
  const parsedUsage = {
    promptTokens: tokenCount('prompt_tokens'),
    completionTokens: tokenCount('completion_tokens'),
    totalTokens: tokenCount('total_tokens'),
  };
  return {
    remoteModel,
    finishReason,
    usage: Object.values(parsedUsage).some((count) => count !== null) ? parsedUsage : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
