import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { preparePilotWorkspace, verifyPilotWorkspace } from '../dist/eval/pilot-workspace.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await preparePilotWorkspace(repositoryRoot);
const verified = await verifyPilotWorkspace(repositoryRoot, workspace.rootDirectory);
console.log(JSON.stringify(verified, null, 2));
