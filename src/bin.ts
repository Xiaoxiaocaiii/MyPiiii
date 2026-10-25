#!/usr/bin/env node

import { runCliAsync } from './cli.js';
import { runDemoCommand } from './eval/demo.js';
import { replayDemoCommand } from './eval/demo-replay.js';
import { runPilotTaskCommand } from './eval/pilot-task.js';
import { runRealEvalBatchCommand } from './eval/real-eval-batch-command.js';

process.exitCode = await runCliAsync(process.argv.slice(2), console.log, {
  commands: {
    demo: runDemoCommand,
    replay: replayDemoCommand,
    'pilot-task': runPilotTaskCommand,
    'real-eval-batch': runRealEvalBatchCommand,
  },
});
