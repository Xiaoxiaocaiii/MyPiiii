import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepSeekModelAdapter } from '../../src/core/deepseek-model.js';
import type { ModelAttemptDiagnostic, ModelRequest } from '../../src/core/model.js';
import {
  createModelAttemptDiagnosticsWriter,
  modelAttemptDiagnosticSchema,
} from '../../src/observability/model-attempt-diagnostics.js';

const request: ModelRequest = {
  schemaVersion: 1,
  sessionId: 'model-diagnostic-test',
  turnIndex: 2,
  inputMessage: 'Inspect the frozen source.',
  model: {
    provider: 'deepseek',
    name: 'deepseek-flash',
    temperature: 0,
    maxOutputTokens: 1024,
  },
};

const validAction = {
  schemaVersion: 1,
  type: 'final_answer',
  content: 'The answer is supported.',
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mypiiii-model-diagnostic-'));
  temporaryDirectories.push(directory);
  return directory;
}

function providerResponse(options: {
  readonly content: string;
  readonly finishReason?: string;
  readonly usage?: unknown;
}): Response {
  return Response.json({
    model: 'deepseek-flash-2026-10',
    choices: [
      {
        finish_reason: options.finishReason ?? 'stop',
        message: { content: options.content },
      },
    ],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}

async function captureDiagnostic(
  fetchMock: typeof fetch,
  signal = new AbortController().signal,
): Promise<{ readonly diagnostic: ModelAttemptDiagnostic | undefined; readonly error?: unknown }> {
  let diagnostic: ModelAttemptDiagnostic | undefined;
  let error: unknown;
  try {
    await new DeepSeekModelAdapter({ apiKey: 'never-persist-this-key', fetch: fetchMock }).complete(
      request,
      {
        signal,
        onAttemptDiagnostic: (entry) => {
          diagnostic = entry;
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { diagnostic, ...(error === undefined ? {} : { error }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

describe('DeepSeek model attempt diagnostics', () => {
  it('records successful response metadata and leaves unavailable usage unknown', async () => {
    const result = await captureDiagnostic(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerResponse({ content: JSON.stringify(validAction) })),
    );

    expect(result.error).toBeUndefined();
    expect(result.diagnostic).toMatchObject({
      schemaVersion: 1,
      sessionId: request.sessionId,
      turnIndex: request.turnIndex,
      modelName: request.model.name,
      httpStatus: 200,
      remoteModel: 'deepseek-flash-2026-10',
      finishReason: 'stop',
      usage: null,
      costEstimate: {
        status: 'unknown',
        amountUsd: null,
        reason: 'pricing_not_frozen',
      },
      responseParseCategory: 'accepted',
      actionSchemaValid: true,
    });
    expect(result.diagnostic?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps usage and length termination when JSON parsing fails', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse({
          content: '{"schemaVersion":',
          finishReason: 'length',
          usage: { prompt_tokens: 101, completion_tokens: 8, total_tokens: 109 },
        }),
      ),
    );

    expect(result.error).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
    expect(result.diagnostic).toMatchObject({
      finishReason: 'length',
      usage: { promptTokens: 101, completionTokens: 8, totalTokens: 109 },
      responseParseCategory: 'invalid_action_json',
      actionSchemaValid: null,
    });
  });

  it('classifies invalid provider JSON without retaining the response body', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    expect(result.error).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
    expect(result.diagnostic).toMatchObject({
      httpStatus: 200,
      responseParseCategory: 'invalid_provider_json',
    });
    expect(JSON.stringify(result)).not.toContain('not-json');
  });

  it('classifies empty assistant content without retaining the response body', async () => {
    const result = await captureDiagnostic(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerResponse({ content: '', usage: { prompt_tokens: 9 } })),
    );

    expect(result.error).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
    expect(result.diagnostic).toMatchObject({
      httpStatus: 200,
      usage: { promptTokens: 9, completionTokens: null, totalTokens: null },
      responseParseCategory: 'empty_content',
    });
  });

  it('classifies parsed JSON that cannot satisfy the internal response schema', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse({
          content: '1e400',
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      ),
    );

    expect(result.error).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
    expect(result.diagnostic).toMatchObject({
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      responseParseCategory: 'invalid_response_schema',
    });
  });

  it('records a recovered leading action separately from the length finish reason', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse({
          content: `${JSON.stringify(validAction)}{"truncated":`,
          finishReason: 'length',
          usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        }),
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.diagnostic).toMatchObject({
      finishReason: 'length',
      responseParseCategory: 'json_parse_recovered',
      actionSchemaValid: true,
      usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
    });
  });

  it('records action-schema validity independently without changing adapter acceptance', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse({
          content: JSON.stringify({ type: 'not-an-action' }),
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.diagnostic).toMatchObject({
      responseParseCategory: 'accepted',
      actionSchemaValid: false,
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    });
  });

  it('records HTTP status but never reads or retains a private provider error body', async () => {
    const result = await captureDiagnostic(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('private response and never-persist-this-key', { status: 429 }),
        ),
    );

    expect(result.error).toMatchObject({ code: 'MODEL_CALL_FAILED' });
    expect(result.diagnostic).toMatchObject({
      httpStatus: 429,
      remoteModel: null,
      usage: null,
      responseParseCategory: 'http_error',
    });
    expect(JSON.stringify(result)).not.toContain('private response');
    expect(JSON.stringify(result)).not.toContain('never-persist-this-key');
  });

  it('distinguishes transport failure and cancellation without persisting error details', async () => {
    const transport = await captureDiagnostic(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport details')),
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await captureDiagnostic(vi.fn<typeof fetch>(), controller.signal);

    expect(transport.error).toMatchObject({ code: 'MODEL_CALL_FAILED' });
    expect(transport.diagnostic?.responseParseCategory).toBe('transport_error');
    expect(cancelled.error).toMatchObject({ code: 'MODEL_CALL_ABORTED' });
    expect(cancelled.diagnostic?.responseParseCategory).toBe('cancelled');
    expect(JSON.stringify([transport, cancelled])).not.toContain('private transport details');
  });

  it('writes validated diagnostics as a versioned JSONL artifact', async () => {
    const result = await captureDiagnostic(
      vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse({
          content: JSON.stringify(validAction),
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }),
      ),
    );
    if (result.diagnostic === undefined) {
      throw new Error('Expected a model attempt diagnostic');
    }
    const path = join(await temporaryDirectory(), 'model-attempts.jsonl');
    const writer = await createModelAttemptDiagnosticsWriter(path);
    await writer.append(result.diagnostic);
    await writer.close();

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(modelAttemptDiagnosticSchema.parse(JSON.parse(lines[0] ?? ''))).toEqual(
      result.diagnostic,
    );
    expect(lines[0]).not.toContain('authorization');
  });

  it('accepts configured model names without treating them as identifiers', async () => {
    const result = await captureDiagnostic(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerResponse({ content: JSON.stringify(validAction) })),
    );
    if (result.diagnostic === undefined) {
      throw new Error('Expected a model attempt diagnostic');
    }

    expect(
      modelAttemptDiagnosticSchema.safeParse({
        ...result.diagnostic,
        modelName: 'DeepSeek V3 (stable)',
      }).success,
    ).toBe(true);
    expect(
      modelAttemptDiagnosticSchema.safeParse({
        ...result.diagnostic,
        modelName: 'invalid\nmodel',
      }).success,
    ).toBe(false);
  });
});
