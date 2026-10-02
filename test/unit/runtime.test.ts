import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExperimentConfig } from '../../src/core/config.js';
import { FakeModelAdapter } from '../../src/core/fake-model.js';
import { ModelAdapterError, type ModelAdapter } from '../../src/core/model.js';
import {
  runAgent,
  runtimeInputSchema,
  runtimeResultSchema,
  type RuntimeInput,
} from '../../src/core/runtime.js';

const config: ExperimentConfig = {
  schemaVersion: 1,
  configId: 'runtime-test',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 1024,
  },
  runtime: {
    maxTurns: 3,
    timeoutMs: 1_000,
  },
  tools: {
    enabled: [],
  },
  artifacts: {
    directory: './artifacts',
  },
};

const input: RuntimeInput = {
  schemaVersion: 1,
  sessionId: 'session-1',
  inputMessage: 'Summarize the repository.',
  config,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runtime contracts', () => {
  it('round-trips completed and failed results', () => {
    const completed = {
      schemaVersion: 1,
      status: 'completed',
      finalOutput: { summary: 'Done' },
      turns: [],
    };
    const failed = {
      schemaVersion: 1,
      status: 'failed',
      error: {
        code: 'UNSUPPORTED_ACTION',
        message: 'Tool calls are not supported',
      },
      turns: [],
    };

    expect(runtimeResultSchema.parse(completed)).toEqual(completed);
    expect(runtimeResultSchema.parse(failed)).toEqual(failed);
  });

  it('rejects runtime-specific configuration duplicates', () => {
    expect(
      runtimeInputSchema.safeParse({
        ...input,
        maxTurns: 10,
      }).success,
    ).toBe(false);
  });
});

describe('runAgent no-tool loop', () => {
  it('returns structured final output and a completed turn', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAnswer({ summary: 'Done' }),
        },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result).toEqual({
      schemaVersion: 1,
      status: 'completed',
      finalOutput: { summary: 'Done' },
      turns: [
        {
          schemaVersion: 1,
          sessionId: 'session-1',
          turnIndex: 0,
          inputMessage: 'Summarize the repository.',
          modelResponse: finalAnswer({ summary: 'Done' }),
          action: finalAnswer({ summary: 'Done' }),
          observations: [],
          stopReason: 'FINAL_ANSWER',
        },
      ],
    });
    expect(runtimeResultSchema.safeParse(result).success).toBe(true);
  });

  it('advances sequential turns after an explicit invalid action', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: {
            schemaVersion: 1,
            type: 'invalid',
            reason: 'Missing final answer',
            raw: { text: 'retry' },
          },
        },
      },
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAnswer('Recovered'),
        },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result.status).toBe('completed');
    expect(result.turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect(adapter.requests[0]).toEqual({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnIndex: 0,
      inputMessage: 'Summarize the repository.',
      model: config.model,
    });
    expect(adapter.requests[1]).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnIndex: 1,
      inputMessage: 'Summarize the repository.',
      model: config.model,
      context: {
        recentTurns: [
          {
            sourceTurnIndex: 0,
            action: {
              schemaVersion: 1,
              type: 'invalid',
              reason: 'Missing final answer',
            },
          },
        ],
      },
    });
    expect(JSON.stringify(adapter.requests[1])).not.toContain('"raw"');
  });

  it('fails without executing a tool call', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: {
            schemaVersion: 1,
            type: 'tool_call',
            callId: 'call-1',
            toolName: 'read-file',
            args: { path: 'README.md' },
          },
        },
      },
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAnswer('Must not run'),
        },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'UNSUPPORTED_ACTION',
      },
    });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.stopReason).toBe('UNSUPPORTED_ACTION');
    expect(adapter.requests).toHaveLength(1);
  });

  it('uses maxTurns from ExperimentConfig', async () => {
    const limitedInput: RuntimeInput = {
      ...input,
      config: {
        ...config,
        runtime: { ...config.runtime, maxTurns: 1 },
      },
    };
    const invalidResponse = {
      schemaVersion: 1 as const,
      output: {
        schemaVersion: 1 as const,
        type: 'invalid' as const,
        reason: 'Retry',
        raw: null,
      },
    };
    const adapter = new FakeModelAdapter([
      { type: 'response', response: invalidResponse },
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAnswer('Must not run'),
        },
      },
    ]);

    const result = await runAgent(limitedInput, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'MAX_TURNS_EXCEEDED',
      },
    });
    expect(result.turns.map((turn) => turn.turnIndex)).toEqual([0]);
    expect(adapter.requests).toHaveLength(1);
  });

  it('allows exactly one repair for malformed model output', async () => {
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: { text: 'not an action' },
        },
      },
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAnswer('Repaired'),
        },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'completed',
      finalOutput: 'Repaired',
    });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]?.action).toBeUndefined();
  });

  it('fails after a second invalid output', async () => {
    const invalidAction = {
      schemaVersion: 1 as const,
      type: 'invalid' as const,
      reason: 'Invalid structure',
      raw: { secret: 'not echoed' },
    };
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: invalidAction },
      },
      {
        type: 'response',
        response: { schemaVersion: 1, output: invalidAction },
      },
    ]);

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'MODEL_OUTPUT_INVALID',
        message: 'The model output is invalid',
      },
    });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[1]?.stopReason).toBe('MODEL_OUTPUT_INVALID');
    expect(result.status === 'failed' ? JSON.stringify(result.error) : '').not.toContain(
      'not echoed',
    );
  });

  it('times out the whole run and cancels the active model call', async () => {
    vi.useFakeTimers();
    const timeoutInput: RuntimeInput = {
      ...input,
      config: {
        ...config,
        runtime: { ...config.runtime, timeoutMs: 25 },
      },
    };
    const adapter = new FakeModelAdapter([{ type: 'wait_for_abort' }]);

    const run = runAgent(timeoutInput, adapter);
    await vi.advanceTimersByTimeAsync(25);

    await expect(run).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'RUN_TIMEOUT' },
    });
  });

  it('honors an already-aborted external signal without calling the model', async () => {
    const controller = new AbortController();
    controller.abort('private abort reason');
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: { schemaVersion: 1, output: finalAnswer('Must not run') },
      },
    ]);

    const result = await runAgent(input, adapter, {
      signal: controller.signal,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      status: 'failed',
      error: {
        code: 'ABORTED',
        message: 'The runtime was aborted',
      },
      turns: [],
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it('aborts an active run and removes the external listener', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const adapter = new FakeModelAdapter([{ type: 'wait_for_abort' }]);

    const run = runAgent(input, adapter, { signal: controller.signal });
    controller.abort('private abort reason');
    const result = await run;

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'ABORTED' },
    });
    expect(JSON.stringify(result)).not.toContain('private abort reason');
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('normalizes adapter response errors without exposing their cause', async () => {
    const adapter: ModelAdapter = {
      complete() {
        return Promise.reject(
          new ModelAdapterError('MODEL_RESPONSE_INVALID', {
            cause: new Error('raw model output: private'),
          }),
        );
      },
    };

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'MODEL_OUTPUT_INVALID',
        cause: {
          name: 'ModelAdapterError',
          code: 'MODEL_RESPONSE_INVALID',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('normalizes unknown adapter failures and retains safe diagnostics', async () => {
    const adapter: ModelAdapter = {
      complete() {
        return Promise.reject(new TypeError('api-key=private'));
      },
    };

    const result = await runAgent(input, adapter);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'MODEL_CALL_FAILED',
        message: 'The model call failed',
        cause: { name: 'TypeError' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('api-key=private');
  });
});

function finalAnswer(content: string | { summary: string }) {
  return {
    schemaVersion: 1 as const,
    type: 'final_answer' as const,
    content,
  };
}
