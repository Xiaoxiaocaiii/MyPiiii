import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createToolContext } from '../../src/core/tool-permissions.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { executeToolCall, type ToolCallAction } from '../../src/core/tool-runtime.js';
import type { ToolContext, ToolDefinition, ToolSideEffect } from '../../src/core/tool.js';

type PathInput = { path: string };
type PathOutput = { path: string };

function createAction(toolName: string, path = 'reports/output.txt'): ToolCallAction {
  return {
    schemaVersion: 1,
    type: 'tool_call',
    callId: 'call-1',
    toolName,
    args: { path },
  };
}

function createTool(
  name: string,
  sideEffect: ToolSideEffect,
  execute: (input: PathInput, context: ToolContext) => Promise<PathOutput>,
): ToolDefinition<PathInput, PathOutput> {
  return {
    schemaVersion: 1,
    name,
    description: `Test ${sideEffect} permission`,
    inputSchema: z.strictObject({ path: z.string().min(1) }),
    outputSchema: z.strictObject({ path: z.string() }),
    timeoutMs: 1_000,
    sideEffect,
    allowedScenarios: ['repo-qa'],
    execute,
  };
}

function createOptions(workspaceRoot?: string) {
  const controller = new AbortController();

  return {
    context: createToolContext({
      scenarioId: 'repo-qa',
      signal: controller.signal,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    }),
    enabledTools: ['read.tool', 'write.tool', 'external.tool'],
    now: vi.fn().mockReturnValueOnce(10).mockReturnValue(12),
  };
}

describe('tool side-effect permissions', () => {
  it('automatically permits an enabled read-only tool with a frozen context', async () => {
    const execute = vi.fn((input: PathInput, context: ToolContext) => {
      expect(Object.isFrozen(context)).toBe(true);
      return Promise.resolve({ path: input.path });
    });
    const registry = new ToolRegistry([createTool('read.tool', 'none', execute)]);

    const observation = await executeToolCall(createAction('read.tool'), registry, createOptions());

    expect(observation).toMatchObject({
      type: 'tool_result',
      data: { path: 'reports/output.txt' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['write.tool', 'local_write'],
    ['external.tool', 'external'],
  ] as const)('denies %s by default', async (name, sideEffect) => {
    const execute = vi.fn(() => Promise.resolve({ path: 'must-not-run' }));
    const registry = new ToolRegistry([createTool(name, sideEffect, execute)]);

    const observation = await executeToolCall(createAction(name), registry, createOptions());

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'PERMISSION_DENIED',
      message: 'The tool call is not permitted',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a workspace capability even when local writes are explicitly granted', async () => {
    const execute = vi.fn(() => Promise.resolve({ path: 'must-not-run' }));
    const registry = new ToolRegistry([createTool('write.tool', 'local_write', execute)]);

    const observation = await executeToolCall(createAction('write.tool'), registry, {
      ...createOptions(),
      permissions: { allowLocalWrite: true },
    });

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'PERMISSION_DENIED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('permits an explicitly granted local write inside the workspace boundary', async () => {
    const workspaceRoot = resolve('workspace');
    const execute = vi.fn((input: PathInput, context: ToolContext) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.workspace)).toBe(true);
      return Promise.resolve({
        path: context.workspace?.resolvePath(input.path) ?? '',
      });
    });
    const registry = new ToolRegistry([createTool('write.tool', 'local_write', execute)]);

    const observation = await executeToolCall(createAction('write.tool'), registry, {
      ...createOptions(workspaceRoot),
      permissions: { allowLocalWrite: true },
    });

    expect(observation).toMatchObject({
      type: 'tool_result',
      data: { path: resolve(workspaceRoot, 'reports/output.txt') },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a local-write path outside the workspace without exposing it', async () => {
    const execute = vi.fn((input: PathInput, context: ToolContext) =>
      Promise.resolve({
        path: context.workspace?.resolvePath(input.path) ?? '',
      }),
    );
    const registry = new ToolRegistry([createTool('write.tool', 'local_write', execute)]);

    const observation = await executeToolCall(
      createAction('write.tool', '../private-secret.txt'),
      registry,
      {
        ...createOptions(resolve('workspace')),
        permissions: { allowLocalWrite: true },
      },
    );

    expect(observation).toMatchObject({
      type: 'tool_error',
      code: 'PERMISSION_DENIED',
      message: 'The tool call is not permitted',
    });
    expect(JSON.stringify(observation)).not.toContain('private-secret');
  });

  it('permits an external tool only after explicit authorization', async () => {
    const execute = vi.fn((input: PathInput) => Promise.resolve({ path: input.path }));
    const registry = new ToolRegistry([createTool('external.tool', 'external', execute)]);

    const observation = await executeToolCall(createAction('external.tool'), registry, {
      ...createOptions(),
      permissions: { allowExternal: true },
    });

    expect(observation).toMatchObject({
      type: 'tool_result',
      data: { path: 'reports/output.txt' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
