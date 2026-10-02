import { expect, expectTypeOf, it } from 'vitest';

import type {
  ModelAdapter,
  ModelCallOptions,
  ModelParameters,
  ModelRequest,
  ModelResponse,
} from '../../src/core/model.js';

it('defines an asynchronous and replaceable ModelAdapter contract', async () => {
  const controller = new AbortController();
  const adapter: ModelAdapter = {
    complete(request, options) {
      expect(options.signal).toBe(controller.signal);

      return Promise.resolve({
        schemaVersion: 1,
        output: {
          receivedSessionId: request.sessionId,
        },
      });
    },
  };

  const request: ModelRequest = {
    schemaVersion: 1,
    sessionId: 'session-1',
    turnIndex: 0,
    inputMessage: 'Test input',
    model: {
      provider: 'fake',
      name: 'deterministic-model',
      temperature: 0,
      maxOutputTokens: 1024,
    },
  };
  const options: ModelCallOptions = { signal: controller.signal };
  const result = adapter.complete(request, options);

  expectTypeOf(result).toEqualTypeOf<Promise<ModelResponse>>();
  await expect(result).resolves.toEqual({
    schemaVersion: 1,
    output: { receivedSessionId: 'session-1' },
  });
  expectTypeOf(request.model).toEqualTypeOf<ModelParameters>();
});
