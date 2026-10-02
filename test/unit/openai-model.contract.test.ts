import { describe } from 'vitest';

import { OpenAIModelAdapter } from '../../src/core/openai-model.js';
import type { ModelRequest } from '../../src/core/model.js';
import { runModelAdapterContract } from './model-adapter-contract.js';

const apiKey = process.env.OPENAI_API_KEY;
const modelName = process.env.OPENAI_MODEL;
const enabled =
  process.env.RUN_REAL_MODEL_TESTS === '1' && apiKey !== undefined && modelName !== undefined;

describe.skipIf(!enabled)('explicit real model contract', () => {
  const request: ModelRequest = {
    schemaVersion: 1,
    sessionId: 'openai-contract',
    turnIndex: 0,
    inputMessage: 'Return {"schemaVersion":1,"type":"final_answer","content":"ok"}.',
    model: {
      provider: 'openai',
      name: modelName ?? 'missing-model',
      temperature: 0,
      maxOutputTokens: 128,
    },
  };

  const createAdapter = (): OpenAIModelAdapter =>
    new OpenAIModelAdapter({
      apiKey: apiKey ?? '',
      ...(process.env.OPENAI_RESPONSES_ENDPOINT === undefined
        ? {}
        : { endpoint: process.env.OPENAI_RESPONSES_ENDPOINT }),
    });

  runModelAdapterContract('OpenAIModelAdapter', {
    request,
    createRespondingAdapter: createAdapter,
    createWaitingAdapter: createAdapter,
  });
});
