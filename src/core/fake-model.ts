import {
  ModelAdapterError,
  modelRequestSchema,
  modelResponseSchema,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelRequest,
  type ModelResponse,
} from './model.js';

export type FakeModelStep =
  | {
      type: 'response';
      response: ModelResponse;
    }
  | {
      type: 'error';
      cause?: unknown;
    }
  | {
      type: 'wait_for_abort';
    };

export class FakeModelAdapter implements ModelAdapter {
  readonly #steps: FakeModelStep[];
  readonly #requests: ModelRequest[] = [];

  constructor(steps: readonly FakeModelStep[]) {
    this.#steps = [...steps];
  }

  get requests(): readonly ModelRequest[] {
    return [...this.#requests];
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse> {
    if (options.signal.aborted) {
      throw new ModelAdapterError('MODEL_CALL_ABORTED', {
        cause: options.signal.reason,
      });
    }

    this.#requests.push(modelRequestSchema.parse(request));
    const step = this.#steps.shift();

    if (step === undefined) {
      throw new ModelAdapterError('MODEL_CALL_FAILED', {
        cause: new Error('Fake model script exhausted'),
      });
    }

    switch (step.type) {
      case 'response': {
        const parsed = modelResponseSchema.safeParse(step.response);
        if (!parsed.success) {
          throw new ModelAdapterError('MODEL_RESPONSE_INVALID', {
            cause: parsed.error,
          });
        }
        return parsed.data;
      }
      case 'error':
        throw new ModelAdapterError(
          'MODEL_CALL_FAILED',
          step.cause === undefined ? undefined : { cause: step.cause },
        );
      case 'wait_for_abort':
        return await waitForAbort(options.signal);
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(
          new ModelAdapterError('MODEL_CALL_ABORTED', {
            cause: signal.reason,
          }),
        );
      },
      { once: true },
    );
  });
}
