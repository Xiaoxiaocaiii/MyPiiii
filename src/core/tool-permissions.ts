import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ToolError, type ToolContext, type ToolSideEffect, type ToolWorkspace } from './tool.js';

export interface ToolPermissionGrants {
  readonly allowExternal?: boolean;
  readonly allowLocalWrite?: boolean;
}

export interface CreateToolContextOptions {
  readonly scenarioId: string;
  readonly signal: AbortSignal;
  readonly workspaceRoot?: string;
}

export function createToolContext(options: CreateToolContextOptions): ToolContext {
  const workspace =
    options.workspaceRoot === undefined ? undefined : createWorkspace(options.workspaceRoot);

  return Object.freeze({
    scenarioId: options.scenarioId,
    signal: options.signal,
    ...(workspace === undefined ? {} : { workspace }),
  });
}

export function isToolPermitted(
  sideEffect: ToolSideEffect,
  grants: ToolPermissionGrants,
  context: ToolContext,
): boolean {
  switch (sideEffect) {
    case 'none':
      return true;
    case 'local_write':
      return grants.allowLocalWrite === true && context.workspace !== undefined;
    case 'external':
      return grants.allowExternal === true;
  }
}

function createWorkspace(rootDirectory: string): ToolWorkspace {
  if (rootDirectory.trim().length === 0) {
    throw new ToolError('PERMISSION_DENIED');
  }

  const resolvedRoot = resolve(rootDirectory);

  return Object.freeze({
    rootDirectory: resolvedRoot,
    resolvePath(path: string): string {
      const candidate = resolve(resolvedRoot, path);
      const relativePath = relative(resolvedRoot, candidate);

      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new ToolError('PERMISSION_DENIED');
      }

      return candidate;
    },
  });
}
