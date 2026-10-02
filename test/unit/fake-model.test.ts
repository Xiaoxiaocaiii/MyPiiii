import { describe, expect, it } from 'vitest';

import { agentActionSchema } from '../../src/core/contracts.js';
import { FakeModelAdapter, type FakeModelStep } from '../../src/core/fake-model.js';
import { ModelAdapterError, type ModelRequest, type ModelResponse } from '../../src/core/model.js';
import { contractRequest, runModelAdapterContract } from './model-adapter-contract.js';

const finalResponse: ModelResponse = {
  schemaVersion: 1,
  output: {
    schemaVersion: 1,
    type: 'final_answer',
    content: { summary: 'Done' },
  },
};

runModelAdapterContract('FakeModelAdapter', {
  createRespondingAdapter: () =>
    new FakeModelAdapter([{ type: 'response', response: finalResponse }]),
  createWaitingAdapter: () => new FakeModelAdapter([{ type: 'wait_for_abort' }]),
});

describe('FakeModelAdapter', () => {
  it('returns scripted responses in order and records request snapshots', async () => {
    const secondResponse: ModelResponse = {
      schemaVersion: 1,
      output: { unexpected: 'action' },
    };
    const adapter = new FakeModelAdapter([
      { type: 'response', response: finalResponse },
      { type: 'response', response: secondResponse },
    ]);
    const firstRequest = createRequest(0);
    const secondRequest = createRequest(1);
    const controller = new AbortController();

    await expect(adapter.complete(firstRequest, { signal: controller.signal })).resolves.toEqual(
      finalResponse,
    );
    await expect(adapter.complete(secondRequest, { signal: controller.signal })).resolves.toEqual(
      secondResponse,
    );

    firstRequest.inputMessage = 'Mutated after the call';
    expect(adapter.requests).toEqual([createRequest(0), secondRequest]);
    expect(agentActionSchema.safeParse(secondResponse.output).success).toBe(false);
  });

  it('does not expose its mutable request collection', async () => {
    const adapter = new FakeModelAdapter([{ type: 'response', response: finalResponse }]);
    const controller = new AbortController();

    await adapter.complete(createRequest(0), { signal: controller.signal });
    const requests = adapter.requests as ModelRequest[];
    requests.length = 0;

    expect(adapter.requests).toHaveLength(1);
  });

  it('wraps a scripted failure in a stable adapter error', async () => {
    const cause = new Error('provider detail');
    const adapter = new FakeModelAdapter([{ type: 'error', cause }]);
    const controller = new AbortController();

    const call = adapter.complete(createRequest(0), {
      signal: controller.signal,
    });

    await expect(call).rejects.toMatchObject({
      name: 'ModelAdapterError',
      code: 'MODEL_CALL_FAILED',
      cause,
    });
  });

  it('waits until the call is cancelled', async () => {
    const adapter = new FakeModelAdapter([{ type: 'wait_for_abort' }]);
    const controller = new AbortController();
    const call = adapter.complete(createRequest(0), {
      signal: controller.signal,
    });

    controller.abort('test cancellation');

    await expect(call).rejects.toMatchObject({
      name: 'ModelAdapterError',
      code: 'MODEL_CALL_ABORTED',
      cause: 'test cancellation',
    });
    expect(adapter.requests).toHaveLength(1);
  });

  it('fails deterministically when the script is exhausted', async () => {
    const adapter = new FakeModelAdapter([{ type: 'response', response: finalResponse }]);
    const controller = new AbortController();

    await adapter.complete(createRequest(0), { signal: controller.signal });
    const exhaustedCall = adapter.complete(createRequest(1), {
      signal: controller.signal,
    });

    await expect(exhaustedCall).rejects.toMatchObject({
      name: 'ModelAdapterError',
      code: 'MODEL_CALL_FAILED',
      message: 'The model call failed',
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('rejects an invalid scripted response envelope', async () => {
    const invalidStep = {
      type: 'response',
      response: { schemaVersion: 1, output: undefined },
    } as unknown as FakeModelStep;
    const adapter = new FakeModelAdapter([invalidStep]);
    const controller = new AbortController();

    const call = adapter.complete(createRequest(0), {
      signal: controller.signal,
    });

    await expect(call).rejects.toMatchObject({
      name: 'ModelAdapterError',
      code: 'MODEL_RESPONSE_INVALID',
      message: 'The model returned an invalid response',
    });
  });

  it('does not consume or record a step when already aborted', async () => {
    const adapter = new FakeModelAdapter([{ type: 'response', response: finalResponse }]);
    const abortedController = new AbortController();
    abortedController.abort();

    await expect(
      adapter.complete(contractRequest, {
        signal: abortedController.signal,
      }),
    ).rejects.toBeInstanceOf(ModelAdapterError);

    const activeController = new AbortController();
    await expect(
      adapter.complete(contractRequest, {
        signal: activeController.signal,
      }),
    ).resolves.toEqual(finalResponse);
    expect(adapter.requests).toHaveLength(1);
  });
});

function createRequest(turnIndex: number): ModelRequest {
  return {
    ...contractRequest,
    turnIndex,
    inputMessage: `Input ${turnIndex}`,
    model: { ...contractRequest.model },
  };
}
