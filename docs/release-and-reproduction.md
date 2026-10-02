# Release And Reproduction

This document describes the supported local release path for MyPiiii. The demonstration
is deterministic and offline: it uses the built-in Fake Model and does not require API
credentials, network access, or interactive input.

## Supported Environment

- Node.js `22.5.0` or newer
- npm `11.11.0` or newer
- Windows PowerShell commands shown below
- A clean Git checkout with the committed `package-lock.json`

The package exposes the compiled CLI as `agent-harness` from `dist/bin.js`. The
project is distributed from its source repository and is not published to the npm
Registry.
The Web/API decision and scope check are recorded in
[`docs/web-api-decision.md`](web-api-decision.md).

## Install And Initialize

From the repository root:

```powershell
npm ci
npm run build
npm start -- --help
npm start -- --version
```

The tracked `artifacts/README.md` documents the generated-artifact directory.
Generated contents are ignored by Git. The demo creates its requested output
directory and refuses to reuse an existing one.

## Standard Demonstration

The single reproducible entry point is:

```powershell
npm run demo
```

It performs these steps in order:

1. Builds `dist/`.
2. Runs the `repo-qa-structure@v1` dataset through the production Eval Runner
   twice.
3. Runs baseline configuration `baseline@v1` with `model.temperature = 0`.
4. Runs ablation configuration `ablation@v1` with `model.temperature = 0.2`.
5. Writes a Markdown comparison report and a `schemaVersion: 1` JSON result.
6. Replays `repo-qa-01` from both variants using persisted Trace artifacts.
7. Removes the isolated temporary output directory.

For artifacts that should remain available for inspection, use a fresh directory:

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm run dev -- demo --output ./artifacts/demo-01
```

The command prints the report path, machine-readable result path, regression
sample, unavailable metrics, and failure Trace reference. The expected result is
one regression, `repo-qa-01`, with baseline score pass rate `1` and ablation score
pass rate `0.95`.

## Replay And Inspection

Replay is read-only and offline. It loads `demo-result.json`, validates the
versioned result and relative Trace reference, then uses the existing Trace
integrity loader, Replay implementation, and consistency analyzer:

```powershell
npm run dev -- replay --demo ./artifacts/demo-01 --variant baseline --case repo-qa-01
npm run dev -- replay --demo ./artifacts/demo-01 --variant ablation --case repo-qa-01
```

The output includes the Session, stop status, turn count, score result, failure
category/code, first consistency issue, and relative Trace path. In the current
demo the ablation regression is a scorer mismatch while the Runtime status remains
`completed`; it is not a model call failure.

The generated directory has this shape:

```text
artifacts/demo-01/
├─ comparison-report.md
├─ demo-result.json
├─ baseline/
│  ├─ eval-runs.sqlite
│  └─ YYYY-MM-DD/<session>/
│     ├─ run-manifest.json
│     ├─ trace.jsonl
│     └─ final-output.json
└─ ablation/
   ├─ eval-runs.sqlite
   └─ YYYY-MM-DD/<session>/
      ├─ run-manifest.json
      ├─ trace.jsonl
      └─ final-output.json
```

## Experiment Identity And Expected Metrics

The demonstration records:

- Dataset: `repo-qa-structure@v1`
- Scenario: `repo-qa@v1`
- Configurations: `baseline@v1` and `ablation@v1`
- Scoring: `v1`, exact-answer scoring
- Primary variable: `model.temperature`, `0` versus `0.2`
- Samples: 20 per configuration
- Expected regression: `repo-qa-01`

The Fake Model makes the result deterministic. Duration, token usage, cost, and
tool-error metrics are reported as `unavailable` when the evidence is absent; they
are never replaced with zero.

## Quality Gate And Failure Handling

Run the full local gate before release or handoff:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:fresh
npm run test:stability
npm run verify
```

`npm run test:fresh` copies the checkout to an isolated temporary directory,
performs `npm ci`, builds there, runs the CLI and complete demo, validates the
generated artifacts and offline Replay, prints command timings, and removes the
temporary directory.

`npm run test:stability` runs the compiled demo five times with independent
output directories, validates the expected metrics and offline Replay on every
run, and writes the versioned summary to
`artifacts/stability-summary.json`. The summary keeps only relative run names,
timings, expected scores, regression counts, Replay status, and engineering
faults.

Common failures:

- `npm ci` fails: check Node/npm versions and use the committed lock file.
- `DEMO_OUTPUT_EXISTS`: choose a new output directory; existing runs are never
  overwritten.
- `DEMO_REPLAY_ARTIFACT_MISSING`: verify that `demo-result.json` and the referenced
  variant Trace directory were preserved together.
- `TRACE_HASH_MISMATCH` or `TRACE_MANIFEST_INVALID`: treat the run as tampered or
  incomplete and rerun the demo in a new directory.
- `CONFIG_*` errors: inspect the configuration shape and avoid using credentials in
  experiment JSON.

CLI errors use stable non-zero exit codes and do not print raw exceptions or local
physical paths.

## Known Limitations And Non-Goals

- The standard demonstration uses Fake Model responses for deterministic validation.
- Remote model runs do not promise token-level or byte-level reproduction.
- Missing timing, token, price, and tool evidence remains `unavailable`.
- The harness is local and single-user; it does not provide a service boundary,
  authentication, RBAC, or remote artifact storage.
- The project does not include Web/API applications, dashboards, multi-agent
  execution, long-term memory, command execution tools, dynamic plugin loading,
  Live Re-run, or Snapshot restoration.
