import { formatProjectSummary, projectInfo } from './project.js';

export type OutputWriter = (message: string) => void;
export const cliExitCodes = {
  success: 0,
  usageError: 1,
  commandError: 2,
} as const;

export type CliExitCode = (typeof cliExitCodes)[keyof typeof cliExitCodes];

export type CliCommand =
  | { readonly type: 'help' }
  | { readonly type: 'version' }
  | { readonly type: 'unknown-option'; readonly value: string }
  | { readonly type: 'command'; readonly name: string; readonly args: readonly string[] };

export type CliCommandHandler = (
  args: readonly string[],
  write: OutputWriter,
) => void | Promise<void>;

export interface CliRunOptions {
  readonly commands?: Readonly<Record<string, CliCommandHandler>>;
}

const HELP_TEXT = [
  'Usage: agent-harness [option]',
  '',
  'Options:',
  '  --help       Show this help message',
  '  --version    Show the project version',
  '',
  'Runtime commands:',
  '  demo         Run the deterministic repo-qa baseline/ablation demo',
  '  replay       Replay a demo case from persisted Trace artifacts',
  '  pilot-task   Run the fixed DeepSeek pilot task (requires DEEPSEEK_MODEL and cost confirmation)',
  '  real-eval-batch  Plan or run an authorized multi-task source evaluation batch',
].join('\n');

export function parseCliArgs(args: readonly string[]): CliCommand {
  if (args.length === 0 || args.includes('--help')) {
    return { type: 'help' };
  }

  if (args.includes('--version')) {
    return { type: 'version' };
  }

  const [first, ...rest] = args;
  if (first === undefined) {
    return { type: 'help' };
  }

  if (first.startsWith('-')) {
    return { type: 'unknown-option', value: first };
  }

  return { type: 'command', name: first, args: rest };
}

function writeHelp(write: OutputWriter): void {
  write(`${formatProjectSummary()}\n\n${HELP_TEXT}`);
}

function writeUnknown(
  command: Extract<CliCommand, { type: 'unknown-option' | 'command' }>,
  write: OutputWriter,
): void {
  const label =
    command.type === 'unknown-option' ? `option: ${command.value}` : `command: ${command.name}`;
  write(`Unknown ${label}\nRun with --help to see available options.`);
}

function publicCommandError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }

  return 'CLI_COMMAND_FAILED';
}

export function runCli(args: string[], write: OutputWriter = console.log): CliExitCode {
  const command = parseCliArgs(args);

  if (command.type === 'help') {
    writeHelp(write);
    return cliExitCodes.success;
  }

  if (command.type === 'version') {
    write(projectInfo.version);
    return cliExitCodes.success;
  }

  writeUnknown(command, write);
  return cliExitCodes.usageError;
}

export async function runCliAsync(
  args: readonly string[],
  write: OutputWriter = console.log,
  options: CliRunOptions = {},
): Promise<CliExitCode> {
  const command = parseCliArgs(args);

  if (command.type === 'help') {
    writeHelp(write);
    return cliExitCodes.success;
  }

  if (command.type === 'version') {
    write(projectInfo.version);
    return cliExitCodes.success;
  }

  if (command.type !== 'command') {
    writeUnknown(command, write);
    return cliExitCodes.usageError;
  }

  const handler = options.commands?.[command.name];
  if (handler === undefined) {
    writeUnknown(command, write);
    return cliExitCodes.usageError;
  }

  try {
    await handler(command.args, write);
    return cliExitCodes.success;
  } catch (error: unknown) {
    write(`Command failed: ${publicCommandError(error)}`);
    return cliExitCodes.commandError;
  }
}
