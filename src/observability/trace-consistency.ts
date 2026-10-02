import { z } from 'zod';

import { type TraceIntegrityError } from './trace-loader.js';
import { type LoadedTraceRun } from './trace-loader.js';
import { replayLoadedTrace } from './trace-replay.js';

export const failureAttributionCategorySchema = z.enum([
  'model',
  'tool',
  'context',
  'runtime',
  'storage',
  'trace_integrity',
  'unknown',
]);

export type FailureAttributionCategory = z.infer<typeof failureAttributionCategorySchema>;

export const traceConsistencyCodeSchema = z.enum([
  'CONSISTENCY_FINAL_OUTPUT_MISMATCH',
  'CONSISTENCY_MANIFEST_STATUS_MISMATCH',
  'CONSISTENCY_SQLITE_STATUS_MISMATCH',
  'CONSISTENCY_TERMINAL_DUPLICATE',
  'CONSISTENCY_TERMINAL_MISSING',
]);

export type TraceConsistencyCode = z.infer<typeof traceConsistencyCodeSchema>;

export const traceConsistencyIssueSchema = z.strictObject({
  code: z.union([traceConsistencyCodeSchema, z.string().min(1)]),
  category: failureAttributionCategorySchema,
  sequence: z.number().int().nonnegative().nullable(),
  eventId: z.string().min(1).nullable(),
  turnIndex: z.number().int().nonnegative().nullable(),
  message: z.string().min(1),
});

export type TraceConsistencyIssue = z.infer<typeof traceConsistencyIssueSchema>;

export const traceConsistencyReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  consistent: z.boolean(),
  issues: z.array(traceConsistencyIssueSchema),
  replay: z
    .strictObject({
      status: z.enum(['completed', 'failed']),
      sessionId: z.string().min(1),
    })
    .optional(),
});

export type TraceConsistencyReport = z.infer<typeof traceConsistencyReportSchema>;

export interface TraceConsistencyOptions {
  readonly sqliteStatus?: 'running' | 'completed' | 'failed';
}

export function analyzeTraceConsistency(
  run: LoadedTraceRun,
  options: TraceConsistencyOptions = {},
): TraceConsistencyReport {
  const issues: TraceConsistencyIssue[] = [];
  let replay: ReturnType<typeof replayLoadedTrace> | undefined;
  try {
    replay = replayLoadedTrace(run);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      issues.push(issue(String(error.code), 'runtime', null, null, null));
    } else {
      issues.push(issue('REPLAY_UNKNOWN_FAILURE', 'unknown', null, null, null));
    }
  }
  const terminalEvents = run.events.filter(
    (event) => event.eventType === 'session.completed' || event.eventType === 'session.failed',
  );

  if (terminalEvents.length === 0) {
    issues.push(issue('CONSISTENCY_TERMINAL_MISSING', 'runtime', null, null, null));
  } else if (terminalEvents.length > 1) {
    const event = terminalEvents[1]!;
    issues.push(
      issue(
        'CONSISTENCY_TERMINAL_DUPLICATE',
        'trace_integrity',
        event.sequence,
        event.eventId,
        event.turnIndex,
      ),
    );
  }

  const terminal = terminalEvents[0];
  const terminalStatus = terminal?.eventType === 'session.completed' ? 'completed' : 'failed';
  if (terminal !== undefined && terminalStatus !== run.manifest.status) {
    issues.push(
      issue(
        'CONSISTENCY_MANIFEST_STATUS_MISMATCH',
        'storage',
        terminal.sequence,
        terminal.eventId,
        terminal.turnIndex,
      ),
    );
  }

  if (options.sqliteStatus !== undefined && options.sqliteStatus !== run.manifest.status) {
    issues.push(issue('CONSISTENCY_SQLITE_STATUS_MISMATCH', 'storage', null, null, null));
  }

  if (terminal?.eventType === 'session.completed') {
    if (!sameJson(terminal.payload.finalOutput, run.finalOutput)) {
      issues.push(
        issue(
          'CONSISTENCY_FINAL_OUTPUT_MISMATCH',
          'storage',
          terminal.sequence,
          terminal.eventId,
          terminal.turnIndex,
        ),
      );
    }
  }

  const result = {
    schemaVersion: 1 as const,
    consistent: issues.length === 0,
    issues,
    ...(replay === undefined
      ? {}
      : {
          replay: {
            status: replay.status,
            sessionId: replay.sessionId,
          },
        }),
  };
  return traceConsistencyReportSchema.parse(result);
}

export function attributeTraceFailure(
  error: TraceIntegrityError | { code: string },
): TraceConsistencyIssue {
  const category = categoryForCode(error.code);
  return issue(error.code, category, null, null, null);
}

function issue(
  code: string,
  category: FailureAttributionCategory,
  sequence: number | null,
  eventId: string | null,
  turnIndex: number | null,
): TraceConsistencyIssue {
  return {
    code,
    category,
    sequence,
    eventId,
    turnIndex,
    message: publicMessage(code),
  };
}

function categoryForCode(code: string): FailureAttributionCategory {
  if (code.startsWith('TRACE_')) {
    return 'trace_integrity';
  }
  if (code.startsWith('MODEL_')) {
    return 'model';
  }
  if (code.startsWith('TOOL_')) {
    return 'tool';
  }
  if (code.startsWith('CONTEXT_')) {
    return 'context';
  }
  if (code.startsWith('RUNTIME_')) {
    return 'runtime';
  }
  if (code.startsWith('ARTIFACT_') || code.startsWith('RUN_INDEX_')) {
    return 'storage';
  }
  return 'unknown';
}

function publicMessage(code: string): string {
  switch (code) {
    case 'CONSISTENCY_FINAL_OUTPUT_MISMATCH':
      return 'The terminal output differs from final-output.json';
    case 'CONSISTENCY_MANIFEST_STATUS_MISMATCH':
      return 'The terminal event status differs from the manifest status';
    case 'CONSISTENCY_SQLITE_STATUS_MISMATCH':
      return 'The SQLite run status differs from the manifest status';
    case 'CONSISTENCY_TERMINAL_DUPLICATE':
      return 'More than one terminal event was observed';
    case 'CONSISTENCY_TERMINAL_MISSING':
      return 'No terminal session event was observed';
    default:
      return 'The persisted run could not be trusted';
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
