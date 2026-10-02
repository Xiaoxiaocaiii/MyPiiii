# Observability

This module provides versioned Trace capture, run artifacts, SQLite run metadata,
and deterministic offline Replay.

`runAgent` depends only on the injected `TraceRecorder` interface. Concrete JSONL,
artifact and SQLite implementations remain outside the Runtime loop.

## Run Artifacts

Each managed run creates:

- `trace.jsonl`: append-only, ordered lifecycle events
- `final-output.json`: the JSON-safe Runtime output
- `run-manifest.json`: versioned artifact metadata, byte counts and SHA-256 hashes
- `run-failure.json`: a detectable marker when finalization fails

Trace events preserve complete normalized Runtime facts. They do not persist the
budgeted `ModelContextView` as a replacement for the original event sequence.
Model tool arguments and error details are redacted at the persistence boundary.

## Replay And Integrity

`loadTraceRun` validates Manifest paths, hashes, JSONL parsing, schema versions,
session identity, sequence continuity and lifecycle pairing. `replayTraceRun`
reconstructs successful and failed runs from validated events only; it never calls
the model or tools. `analyzeTraceConsistency` reports mismatches and assigns a
stable failure category.

The run index uses the built-in `node:sqlite` `DatabaseSync` driver. It is
available from Node.js 22.5.0, requires no native npm dependency or external
service, and stores only versioned searchable metadata.
