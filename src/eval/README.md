# Eval

The Eval boundary provides a versioned `repo-qa` dataset, deterministic scoring,
production-path Runner, measurement capture, metric aggregation, and baseline/ablation
comparison reports.

Evaluation reuses `runAgent` and finalized run artifacts. Every sample keeps its Session and Trace
reference; Replay remains offline and never calls a real model or tool. Missing token,
cost, or timing evidence is reported as unavailable rather than inferred as zero.
