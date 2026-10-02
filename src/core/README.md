# Core

`core` contains the contracts for the deterministic execution kernel:

- `config`: versioned runtime and experiment configuration validated with Zod
- `config-loader`: JSON loading, environment overrides, and stable configuration errors
- `contracts`: versioned `Session`, `Turn`, `AgentAction`, and `Observation` data contracts
- `model`: provider-neutral request, response, adapter, and error contracts
- `fake-model`: deterministic in-memory Adapter for tests and local experiments
- `openai-model`: optional OpenAI Responses API Adapter with injected credentials
- `tool`: Schema-first tool definitions, minimal execution context, and stable errors
- `tool-registry`: explicit startup-time registration and availability filtering
- `tool-permissions`: minimal side-effect grants and workspace path boundaries
- `tool-runtime`: validated, timed, and normalized single-tool execution
- `context-window`: deterministic model context views independent of future Trace storage
- `runtime`: synchronous single-agent loop, optional tool injection, and stopping rules

Scenario-specific behavior must not be implemented in this directory.

Trace persistence and evaluation remain outside this module. RBAC, command execution,
dynamic plugins, multi-agent execution, and long-term memory are intentionally out of
scope.
