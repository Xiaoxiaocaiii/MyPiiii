import { describe, expect, it } from 'vitest';

import { modelResponseSchema, type ModelAdapter, type ModelRequest } from '../../src/core/model.js';

export const contractRequest: ModelRequest = {
  schemaVersion: 1,
  sessionId: 'contract-session',
  turnIndex: 0,
  inputMessage: 'Contract test input',
  model: {
    provider: 'fake',
    name: 'contract-model',
    temperature: 0,
    maxOutputTokens: 128,
  },
};

interface ModelAdapterContractFactory {
  createRespondingAdapter(): ModelAdapter;
  createWaitingAdapter(): ModelAdapter;
  request?: ModelRequest;
}

export function runModelAdapterContract(name: string, factory: ModelAdapterContractFactory): void {
  describe(`${name} ModelAdapter contract`, () => {
    it('returns the unified model response contract', async () => {
      const adapter = factory.createRespondingAdapter();
      const controller = new AbortController();

      const response = await adapter.complete(factory.request ?? contractRequest, {
        signal: controller.signal,
      });

      expect(modelResponseSchema.safeParse(response).success).toBe(true);
    });

    it('rejects a pre-aborted call with the stable adapter error', async () => {
      const adapter = factory.createWaitingAdapter();
      const controller = new AbortController();
      controller.abort('contract cancellation');

      const call = adapter.complete(factory.request ?? contractRequest, {
        signal: controller.signal,
      });

      await expect(call).rejects.toMatchObject({
        name: 'ModelAdapterError',
        code: 'MODEL_CALL_ABORTED',
      });
    });
  });
}
