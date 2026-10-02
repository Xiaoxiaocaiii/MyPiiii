#!/usr/bin/env node

import { runCliAsync } from './cli.js';
import { runDemoCommand } from './eval/demo.js';
import { replayDemoCommand } from './eval/demo-replay.js';

process.exitCode = await runCliAsync(process.argv.slice(2), console.log, {
  commands: { demo: runDemoCommand, replay: replayDemoCommand },
});
