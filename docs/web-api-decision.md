# Web/API Necessity Decision

## Decision

The project does **not** include a Web/API application, dashboard, HTTP service,
or frontend. The current CLI and persisted Markdown/JSON artifacts express every
result required by the supported experiment workflow. No additional service
boundary is justified.

## Evidence

The compiled CLI and standard `npm run demo` output provide:

| Required result                 | Existing CLI/artifact                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Installation and initialization | `npm ci`, `npm run build`, `npm start -- --help`                                |
| Experiment identity             | `Dataset: repo-qa-structure@v1`, scenario/config identity in `demo-result.json` |
| Configuration comparison        | Baseline and ablation pass rates plus `model.temperature` in the report         |
| Core metrics                    | Pass rates, regression count, unavailable metric list                           |
| Regression samples              | `repo-qa-01` in CLI output and `comparison-report.md`                           |
| Trace location                  | Relative failure Trace reference in CLI output and report                       |
| Offline Replay                  | `replay --demo ... --variant ... --case ...`                                    |
| Failure attribution             | Replay status, score result, failure category/code, first inconsistency         |
| Reproduction steps              | `README.md` and `docs/release-and-reproduction.md`                              |

The standard demo has been validated in a clean environment and across five
isolated runs. It produces 20 samples per configuration, baseline score pass rate
`1`, ablation score pass rate `0.95`, and one expected scorer regression. This is
enough information for local inspection and reproduction without a server.

## Scope Check

`npm run test:scope` checks that:

- runtime and development dependencies contain no Web/API framework or frontend
  package;
- `src/` contains no `api`, `frontend`, `server`, or `web` entry directory;
- the compiled CLI still exposes both `demo` and `replay`.

The current dependency set contains `zod` at runtime and local build/test tooling
only. The optional `OpenAIModelAdapter` uses injected `fetch` for a model provider;
it is not an HTTP service exposed by this project.

## Reconsideration Gate

Web/API work may be reconsidered only if a later requirement demonstrates that the
CLI and static artifacts cannot express a required result, such as interactive
multi-user access, remote artifact browsing, or a demonstrated volume/latency need.
That evidence must be recorded before adding a framework or service dependency.
