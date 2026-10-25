import { z } from 'zod';

import type { JsonValue } from '../core/contracts.js';
import type { ModelRequest } from '../core/model.js';
import { ToolError, type ToolDefinition } from '../core/tool.js';
import { ToolRegistry } from '../core/tool-registry.js';
import {
  readRealEvalSnapshotFiles,
  realEvalSourcePaths,
  type RealEvalSnapshot,
} from './real-eval-snapshot.js';

export const realEvalToolNames = [
  'repo.list_files',
  'repo.search_source',
  'repo.read_file_lines',
] as const;

const MAX_MATCHES = 20;
const MAX_SEARCH_SNIPPET_CODE_POINTS = 240;
const MAX_SEARCH_OUTPUT_BYTES = 8 * 1024;
const MAX_READ_LINES = 80;
const MAX_READ_LINE_BYTES = 512;
const MAX_READ_OUTPUT_BYTES = 16 * 1024;
const MAX_LIST_OUTPUT_BYTES = 4 * 1024;
const TOOL_TIMEOUT_MS = 15_000;

const sourcePathSchema = z.enum(realEvalSourcePaths);
const listInputSchema = z.strictObject({});
const listOutputSchema = z.strictObject({
  files: z.array(sourcePathSchema).length(realEvalSourcePaths.length),
});

const searchInputSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(128),
    caseSensitive: z.boolean().optional().describe('Defaults to false when omitted.'),
  })
  .describe('Search only the frozen source allowlist for a literal substring.');
const searchMatchSchema = z.strictObject({
  path: sourcePathSchema,
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().refine((text) => [...text].length <= MAX_SEARCH_SNIPPET_CODE_POINTS),
  lineTruncated: z.boolean(),
});
const searchOutputSchema = z.strictObject({
  matches: z.array(searchMatchSchema).max(MAX_MATCHES),
  truncated: z.boolean(),
});

const lineNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const readInputSchema = z
  .strictObject({
    path: sourcePathSchema,
    startLine: lineNumberSchema,
    endLine: lineNumberSchema,
  })
  .superRefine((input, context) => {
    if (input.endLine < input.startLine) {
      context.addIssue({
        code: 'custom',
        message: 'endLine must not be less than startLine',
        path: ['endLine'],
      });
    } else if (input.endLine - input.startLine + 1 > MAX_READ_LINES) {
      context.addIssue({
        code: 'custom',
        message: `A read may request at most ${MAX_READ_LINES} lines`,
        path: ['endLine'],
      });
    }
  })
  .describe(
    `Line numbers are 1-based and inclusive. endLine must be greater than or equal to startLine, and the requested range must contain at most ${MAX_READ_LINES} lines.`,
  );
const readLineSchema = z.strictObject({
  line: lineNumberSchema,
  text: z.string().refine((text) => Buffer.byteLength(text, 'utf8') <= MAX_READ_LINE_BYTES),
});
const readOutputSchema = z.strictObject({
  path: sourcePathSchema,
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  lines: z.array(readLineSchema).max(MAX_READ_LINES),
  truncated: z.boolean(),
});

type ListInput = z.infer<typeof listInputSchema>;
type ListOutput = z.infer<typeof listOutputSchema>;
type SearchInput = z.infer<typeof searchInputSchema>;
type SearchOutput = z.infer<typeof searchOutputSchema>;
type ReadInput = z.infer<typeof readInputSchema>;
type ReadOutput = z.infer<typeof readOutputSchema>;

export function createRealEvalToolRegistry(snapshot: RealEvalSnapshot): ToolRegistry {
  const listFiles: ToolDefinition<ListInput, ListOutput> = {
    schemaVersion: 1,
    name: 'repo.list_files',
    description: 'List the 18 source files in the verified real-evaluation snapshot.',
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    async execute(_input, context) {
      await readRealEvalSnapshotFiles(snapshot, [realEvalSourcePaths[0]], context.signal);
      const output = { files: [...realEvalSourcePaths] };
      assertOutputByteLimit(output, MAX_LIST_OUTPUT_BYTES);
      return output;
    },
  };

  const searchSource: ToolDefinition<SearchInput, SearchOutput> = {
    schemaVersion: 1,
    name: 'repo.search_source',
    description:
      'Search the verified 18-file snapshot for a literal substring; results include source paths and 1-based line numbers.',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    async execute(input, context) {
      const sources = await readRealEvalSnapshotFiles(
        snapshot,
        realEvalSourcePaths,
        context.signal,
      );
      const matches: SearchOutput['matches'] = [];
      let truncated = false;
      const caseSensitive = input.caseSensitive ?? false;
      const normalizedQuery = caseSensitive ? input.query : input.query.toLowerCase();

      search: for (const path of realEvalSourcePaths) {
        throwIfAborted(context.signal);
        const contents = sources.get(path);
        if (contents === undefined) {
          throw new ToolError('EXECUTION_FAILED');
        }

        const lines = contents.toString('utf8').split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          throwIfAborted(context.signal);
          const line = lines[index] ?? '';
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (!haystack.includes(normalizedQuery)) {
            continue;
          }
          if (matches.length === MAX_MATCHES) {
            truncated = true;
            break search;
          }

          const snippet = truncateCodePoints(line, MAX_SEARCH_SNIPPET_CODE_POINTS);
          const match = {
            path,
            line: index + 1,
            text: snippet.text,
            lineTruncated: snippet.truncated,
          };
          const candidate = {
            matches: [...matches, match],
            truncated: truncated || snippet.truncated,
          };
          if (serializedByteLength(candidate) > MAX_SEARCH_OUTPUT_BYTES) {
            truncated = true;
            break search;
          }
          matches.push(match);
          truncated ||= snippet.truncated;
        }
      }

      const output = { matches, truncated };
      assertOutputByteLimit(output, MAX_SEARCH_OUTPUT_BYTES);
      return output;
    },
  };

  const readFileLines: ToolDefinition<ReadInput, ReadOutput> = {
    schemaVersion: 1,
    name: 'repo.read_file_lines',
    description: `Read up to ${MAX_READ_LINES} inclusive, 1-based lines from one of the 18 frozen source files.`,
    inputSchema: readInputSchema,
    outputSchema: readOutputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    sideEffect: 'none',
    allowedScenarios: ['repo-qa'],
    async execute(input, context) {
      const contents = await readRealEvalSnapshotFiles(snapshot, [input.path], context.signal);
      const source = contents.get(input.path);
      if (source === undefined) {
        throw new ToolError('EXECUTION_FAILED');
      }
      const sourceLines = source.toString('utf8').split(/\r\n|\n|\r/);
      const lines: ReadOutput['lines'] = [];
      let truncated = false;
      const lastLine = Math.min(input.endLine, sourceLines.length);

      for (let lineNumber = input.startLine; lineNumber <= lastLine; lineNumber += 1) {
        throwIfAborted(context.signal);
        const sourceText = sourceLines[lineNumber - 1] ?? '';
        const clipped = truncateUtf8(sourceText, MAX_READ_LINE_BYTES);
        const candidate = {
          path: input.path,
          startLine: input.startLine,
          endLine: input.endLine,
          lines: [...lines, { line: lineNumber, text: clipped.text }],
          truncated: truncated || clipped.truncated,
        };
        if (serializedByteLength(candidate) > MAX_READ_OUTPUT_BYTES) {
          truncated = true;
          break;
        }
        lines.push({ line: lineNumber, text: clipped.text });
        truncated ||= clipped.truncated;
      }

      const output = {
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        lines,
        truncated,
      };
      assertOutputByteLimit(output, MAX_READ_OUTPUT_BYTES);
      return output;
    },
  };

  return new ToolRegistry([listFiles, searchSource, readFileLines]);
}

export function createRealEvalSnapshotPreflight(
  snapshot: RealEvalSnapshot,
): (request: ModelRequest, signal: AbortSignal) => Promise<void> {
  return async (_request, signal) => {
    await readRealEvalSnapshotFiles(snapshot, [realEvalSourcePaths[0]], signal);
  };
}

function truncateCodePoints(
  text: string,
  maxCodePoints: number,
): { readonly text: string; readonly truncated: boolean } {
  const codePoints = [...text];
  if (codePoints.length <= maxCodePoints) {
    return { text, truncated: false };
  }
  return {
    text: codePoints.slice(0, maxCodePoints).join(''),
    truncated: true,
  };
}

function truncateUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  let byteCount = 0;
  let result = '';
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (byteCount + codePointBytes > maxBytes) {
      return { text: result, truncated: true };
    }
    result += codePoint;
    byteCount += codePointBytes;
  }
  return { text: result, truncated: false };
}

function serializedByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertOutputByteLimit(value: JsonValue, maximumBytes: number): void {
  if (serializedByteLength(value) > maximumBytes) {
    throw new ToolError('OUTPUT_INVALID');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolError('EXECUTION_FAILED');
  }
}
