import { describe, expect, it } from 'vitest';

import { experimentConfigSchema } from '../../src/core/config.js';
import {
  buildContextWindow,
  contextCharacters,
  ContextBudgetError,
  defaultContextWindowSettings,
  modelContextViewSchema,
} from '../../src/core/context-window.js';
import type { AgentAction, Observation, Turn } from '../../src/core/contracts.js';
import { FakeModelAdapter } from '../../src/core/fake-model.js';
import { runAgent, type RuntimeInput } from '../../src/core/runtime.js';

const baseConfig = {
  schemaVersion: 1 as const,
  configId: 'context-test',
  scenarioId: 'repo-qa',
  model: {
    provider: 'fake',
    name: 'deterministic-model',
    temperature: 0,
    maxOutputTokens: 128,
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

function finalAction(content: string): AgentAction {
  return {
    schemaVersion: 1,
    type: 'final_answer',
    content,
  };
}

function invalidAction(reason: string): AgentAction {
  return {
    schemaVersion: 1,
    type: 'invalid',
    reason,
    raw: null,
  };
}

function resultObservation(callId: string, data: string): Observation {
  return {
    schemaVersion: 1,
    type: 'tool_result',
    callId,
    toolName: 'repository.search',
    data,
    truncated: false,
    durationMs: 5,
  };
}

function createTurn(
  turnIndex: number,
  action: AgentAction,
  observations: Observation[] = [],
): Turn {
  return {
    schemaVersion: 1,
    sessionId: 'context-session',
    turnIndex,
    inputMessage: 'Inspect the runtime.',
    action,
    modelResponse: action,
    observations,
  };
}

describe('context window configuration', () => {
  it('keeps existing configuration valid and applies explicit context defaults', () => {
    const existing = experimentConfigSchema.parse(baseConfig);
    const configured = experimentConfigSchema.parse({
      ...baseConfig,
      context: {},
    });

    expect(existing.context).toBeUndefined();
    expect(configured.context).toEqual(defaultContextWindowSettings);
  });
});

describe('buildContextWindow', () => {
  it('builds a versioned context view within the character budget', () => {
    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [createTurn(0, finalAction('First'))],
    });

    expect(modelContextViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({
      schemaVersion: 1,
      taskInput: 'Inspect the runtime.',
      recentTurns: [{ sourceTurnIndex: 0 }],
      omittedTurnCount: 0,
      omittedObservationCount: 0,
    });
    expect(contextCharacters(view)).toBeLessThanOrEqual(defaultContextWindowSettings.maxCharacters);
  });

  it('keeps only the most recent configured number of turns', () => {
    const turns = [
      createTurn(0, invalidAction('Zero')),
      createTurn(1, invalidAction('One')),
      createTurn(2, invalidAction('Two')),
    ];

    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns,
      settings: { recentTurns: 2 },
    });

    expect(view.recentTurns.map((turn) => turn.sourceTurnIndex)).toEqual([1, 2]);
    expect(view.omittedTurnCount).toBe(1);
  });

  it('retains only the newest exact duplicate turn and observation', () => {
    const repeatedAction = finalAction('Same');
    const repeatedObservation = resultObservation('call-1', 'same-result');
    const turns = [
      createTurn(0, repeatedAction, [repeatedObservation]),
      createTurn(1, repeatedAction, [repeatedObservation]),
    ];

    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns,
    });

    expect(view.recentTurns).toHaveLength(1);
    expect(view.recentTurns[0]?.sourceTurnIndex).toBe(1);
    expect(view.observations).toHaveLength(1);
    expect(view.observations[0]?.sourceTurnIndex).toBe(1);
    expect(view.omittedTurnCount).toBe(1);
    expect(view.omittedObservationCount).toBe(1);
  });

  it('deterministically truncates large observations while retaining their source', () => {
    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [createTurn(3, finalAction('Done'), [resultObservation('call-3', 'x'.repeat(100))])],
      settings: { observationMaxCharacters: 20 },
    });

    const entry = view.observations[0];
    expect(entry).toMatchObject({
      sourceTurnIndex: 3,
      callId: 'call-3',
      toolName: 'repository.search',
      truncated: true,
      observation: {
        type: 'tool_result',
        callId: 'call-3',
        toolName: 'repository.search',
        truncated: true,
      },
    });
    expect(
      entry?.observation.type === 'tool_result' && typeof entry.observation.data === 'string'
        ? entry.observation.data.length
        : 0,
    ).toBe(20);
  });

  it('prioritizes recent turns over observations when the budget is constrained', () => {
    const turnWithoutObservation = createTurn(0, finalAction('Done'));
    const turnOnlyView = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [turnWithoutObservation],
    });
    const turnWithObservation = createTurn(0, finalAction('Done'), [
      resultObservation('call-1', 'result'),
    ]);

    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [turnWithObservation],
      settings: {
        maxCharacters: contextCharacters(turnOnlyView),
      },
    });

    expect(view.recentTurns).toHaveLength(1);
    expect(view.observations).toEqual([]);
    expect(view.omittedObservationCount).toBe(1);
  });

  it('throws a stable error rather than dropping required context', () => {
    expect(() =>
      buildContextWindow({
        taskInput: 'Required task',
        turns: [],
        settings: { maxCharacters: 1 },
      }),
    ).toThrowError(ContextBudgetError);
  });
});

describe('runtime context budget', () => {
  it('returns CONTEXT_BUDGET_EXCEEDED without calling the model', async () => {
    const runtimeInput: RuntimeInput = {
      schemaVersion: 1,
      sessionId: 'context-session',
      inputMessage: 'Required task',
      config: {
        ...baseConfig,
        context: {
          maxCharacters: 1,
          recentTurns: 4,
          observationMaxCharacters: 2_000,
        },
      },
    };
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAction('Must not run'),
        },
      },
    ]);

    const result = await runAgent(runtimeInput, adapter);

    expect(result).toEqual({
      schemaVersion: 1,
      status: 'failed',
      error: {
        code: 'CONTEXT_BUDGET_EXCEEDED',
        message: 'The required context exceeds the character budget',
      },
      turns: [],
    });
    expect(adapter.requests).toHaveLength(0);
  });
});
