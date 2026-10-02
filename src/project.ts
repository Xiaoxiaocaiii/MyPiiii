export const projectInfo = {
  name: 'Agent Playground Harness',
  packageName: 'agent-playground-harness',
  version: '0.1.0',
  description: 'A minimal local harness for running, tracing, replaying, and evaluating agents.',
} as const;

export function formatProjectSummary(): string {
  return [`${projectInfo.name} v${projectInfo.version}`, projectInfo.description].join('\n');
}
