import { evalDatasetSchema, parseEvalDataset, type EvalDataset } from './eval-contracts.js';

const questions = [
  ['Where is the main Runtime implementation?', 'src/core/runtime.ts', ['runtime']],
  ['Where are the core JSON-safe contracts defined?', 'src/core/contracts.ts', ['contracts']],
  ['Where is the Fake Model Adapter implemented?', 'src/core/fake-model.ts', ['model']],
  ['Where is the optional OpenAI adapter implemented?', 'src/core/openai-model.ts', ['model']],
  ['Where is the Tool Registry implemented?', 'src/core/tool-registry.ts', ['tools']],
  [
    'Where is tool execution and timeout handling implemented?',
    'src/core/tool-runtime.ts',
    ['tools'],
  ],
  ['Where is the minimal context window implemented?', 'src/core/context-window.ts', ['context']],
  ['Where is experiment configuration validated?', 'src/core/config.ts', ['config']],
  ['Where is JSON configuration loading implemented?', 'src/core/config-loader.ts', ['config']],
  [
    'Where are versioned Trace contracts defined?',
    'src/observability/trace-contracts.ts',
    ['trace'],
  ],
  ['Where is the Trace recorder implemented?', 'src/observability/trace-recorder.ts', ['trace']],
  [
    'Where is append-only JSONL Trace writing implemented?',
    'src/observability/jsonl-trace-sink.ts',
    ['trace'],
  ],
  [
    'Where is the SQLite run index implemented?',
    'src/observability/sqlite-run-index.ts',
    ['storage'],
  ],
  ['Where are artifact runs finalized?', 'src/observability/artifact-run.ts', ['storage']],
  [
    'Where is Trace loading and integrity validation implemented?',
    'src/observability/trace-loader.ts',
    ['replay'],
  ],
  [
    'Where is deterministic Trace Replay implemented?',
    'src/observability/trace-replay.ts',
    ['replay'],
  ],
  [
    'Where is Trace consistency analysis implemented?',
    'src/observability/trace-consistency.ts',
    ['replay'],
  ],
  ['Where is the repo-qa scenario adapter implemented?', 'src/scenarios/repo-qa.ts', ['scenario']],
  ['Where are Eval data and result contracts defined?', 'src/eval/eval-contracts.ts', ['eval']],
  ['Where is the project CLI entrypoint implemented?', 'src/cli.ts', ['cli']],
] as const;

const datasetDefinition = {
  schemaVersion: 1 as const,
  datasetId: 'repo-qa-structure',
  version: 'v1',
  scenarioId: 'repo-qa',
  scenarioVersion: 'v1',
  cases: questions.map(([question, answer, tags], index) => ({
    schemaVersion: 1 as const,
    caseId: `repo-qa-${String(index + 1).padStart(2, '0')}`,
    input: { question },
    expected: { answer },
    tags: [...tags, 'structure'],
    scoringRules: [{ ruleId: 'exact-answer', type: 'exact_match' as const }],
  })),
};

export const repoQaDataset = evalDatasetSchema.parse(datasetDefinition);

export function loadRepoQaDataset(): EvalDataset {
  return parseEvalDataset(datasetDefinition);
}
