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

  it('includes concrete JSON examples for each supported action in system rules', () => {
    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [],
    });

    expect(view.systemRules).toContain(
      'Output one JSON object only. Never return multiple JSON objects, newline-delimited JSON, Markdown, or prose. For tool use, choose exactly one tool_call and wait for its observation before requesting another tool.',
    );
    expect(view.systemRules).toContain(
      'Example final_answer JSON: {"schemaVersion":1,"type":"final_answer","content":"answer"}',
    );
    expect(view.systemRules).toContain(
      'Example tool_call JSON: {"schemaVersion":1,"type":"tool_call","callId":"call-1","toolName":"repo.search_source","args":{"query":"ContextBudgetError"}}',
    );
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
    expect(view.omissionReasons).toMatchObject({ recentTurnLimit: 1 });
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
    expect(view.omissionReasons).toMatchObject({
      duplicateTurns: 1,
      duplicateObservations: 1,
    });
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
      truncationReasons: ['context_character_limit'],
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
    expect(view.truncationReasons).toMatchObject({
      contextCharacterLimitObservations: 1,
      toolOutputLimitObservations: 0,
    });
  });

  it('records tool-output truncation separately from Context character truncation', () => {
    const truncated = {
      ...resultObservation('call-truncated', 'partial-result'),
      truncated: true,
    };
    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [createTurn(0, finalAction('Done'), [truncated])],
    });

    expect(view.observations[0]?.truncationReasons).toEqual(['tool_output_limit']);
    expect(view.truncationReasons).toMatchObject({
      toolOutputLimitObservations: 1,
      contextCharacterLimitObservations: 0,
    });
  });

  it('retains truncation reasons when the affected observation is also omitted', () => {
    const turn = createTurn(0, finalAction('Done'), [
      resultObservation('call-omitted', 'x'.repeat(100)),
    ]);
    const fullView = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [turn],
      settings: { observationMaxCharacters: 10 },
    });
    const view = buildContextWindow({
      taskInput: 'Inspect the runtime.',
      turns: [turn],
      settings: {
        maxCharacters: contextCharacters(fullView) - 1,
        observationMaxCharacters: 10,
      },
    });

    expect(view.observations).toEqual([]);
    expect(view.omittedObservationCount).toBe(1);
    expect(view.omissionReasons).toMatchObject({ characterBudgetObservations: 1 });
    expect(view.truncationReasons).toMatchObject({
      contextCharacterLimitObservations: 1,
    });
  });

  it('includes visible tool descriptions in the character budget', () => {
    const input = {
      taskInput: 'Inspect the runtime.',
      turns: [],
    };
    const noToolView = buildContextWindow(input);
    const visibleTools = [
      {
        schemaVersion: 1 as const,
        name: 'repo.search_source',
        description: 'Search a fixed, permitted collection of source files.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];

    expect(() =>
      buildContextWindow({
        ...input,
        visibleTools,
        settings: { maxCharacters: contextCharacters(noToolView) },
      }),
    ).toThrowError(ContextBudgetError);
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
    expect(view.omissionReasons).toMatchObject({
      characterBudgetObservations: 1,
    });
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

  it('records why prior turns were omitted from a Fake Model request', async () => {
    const runtimeInput: RuntimeInput = {
      schemaVersion: 1,
      sessionId: 'context-session',
      inputMessage: 'Inspect the runtime.',
      config: {
        ...baseConfig,
        context: {
          maxCharacters: 4_000,
          recentTurns: 0,
          observationMaxCharacters: 2_000,
        },
      },
    };
    const adapter = new FakeModelAdapter([
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: invalidAction('Retry'),
        },
      },
      {
        type: 'response',
        response: {
          schemaVersion: 1,
          output: finalAction('Done'),
        },
      },
    ]);

    const result = await runAgent(runtimeInput, adapter);

    expect(result.status).toBe('completed');
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.context).toMatchObject({
      recentTurns: [],
      omittedTurnCount: 0,
    });
    expect(adapter.requests[1]?.context).toMatchObject({
      recentTurns: [],
      omittedTurnCount: 1,
      omissionReasons: {
        duplicateTurns: 0,
        recentTurnLimit: 1,
        characterBudgetTurns: 0,
      },
    });
  });
});
