import { describe, expect, it } from 'vitest';

import { cliExitCodes, parseCliArgs, runCli, runCliAsync } from '../../src/cli.js';
import { formatProjectSummary, projectInfo } from '../../src/project.js';

function captureRun(args: string[]): { exitCode: number; output: string[] } {
  const output: string[] = [];
  const exitCode = runCli(args, (message) => output.push(message));

  return { exitCode, output };
}

describe('project metadata', () => {
  it('formats a stable project summary', () => {
    expect(formatProjectSummary()).toContain(projectInfo.name);
    expect(formatProjectSummary()).toContain(projectInfo.version);
    expect(formatProjectSummary()).toContain(projectInfo.description);
  });
});

describe('runCli', () => {
  it.each([{ args: [] }, { args: ['--help'] }])('prints help for arguments $args', ({ args }) => {
    const result = captureRun(args);

    expect(result.exitCode).toBe(0);
    expect(result.output.join('\n')).toContain('Usage: agent-harness');
  });

  it('prints the current version', () => {
    const result = captureRun(['--version']);

    expect(result).toEqual({ exitCode: 0, output: [projectInfo.version] });
  });

  it('rejects an unknown option', () => {
    const result = captureRun(['--unknown']);

    expect(result.exitCode).toBe(cliExitCodes.usageError);
    expect(result.output.join('\n')).toContain('Unknown option: --unknown');
  });

  it('keeps unknown commands separate from unknown options', () => {
    expect(parseCliArgs(['demo', '--output', 'artifacts'])).toEqual({
      type: 'command',
      name: 'demo',
      args: ['--output', 'artifacts'],
    });
    expect(runCli(['demo'], () => undefined)).toBe(cliExitCodes.usageError);
  });
});

describe('async CLI command boundary', () => {
  it('dispatches an injected command and preserves its arguments', async () => {
    const output: string[] = [];
    const received: string[][] = [];

    const exitCode = await runCliAsync(
      ['demo', '--output', 'artifacts'],
      (message) => output.push(message),
      {
        commands: {
          demo: (args, write) => {
            received.push([...args]);
            write('demo completed');
          },
        },
      },
    );

    expect(exitCode).toBe(cliExitCodes.success);
    expect(received).toEqual([['--output', 'artifacts']]);
    expect(output).toEqual(['demo completed']);
  });

  it('normalizes command failures without exposing raw errors or paths', async () => {
    const output: string[] = [];
    const exitCode = await runCliAsync(['demo'], (message) => output.push(message), {
      commands: {
        demo: () => {
          throw Object.assign(new Error('C:\\private\\secret.txt'), {
            code: 'DEMO_FAILED',
          });
        },
      },
    });

    expect(exitCode).toBe(cliExitCodes.commandError);
    expect(output).toEqual(['Command failed: DEMO_FAILED']);
    expect(output.join('\n')).not.toContain('private');
    expect(output.join('\n')).not.toContain('secret.txt');
  });

  it('uses a stable fallback code for unknown command failures', async () => {
    const output: string[] = [];
    const exitCode = await runCliAsync(['demo'], (message) => output.push(message), {
      commands: {
        demo: () => {
          throw new Error('unexpected internal detail');
        },
      },
    });

    expect(exitCode).toBe(cliExitCodes.commandError);
    expect(output).toEqual(['Command failed: CLI_COMMAND_FAILED']);
  });
});
