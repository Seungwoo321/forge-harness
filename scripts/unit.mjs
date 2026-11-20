#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPublicUnitCli } from './lib/runtime-adapters.mjs';
import { installDeferredTermination } from './lib/deferred-termination.mjs';

installDeferredTermination();

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const output = await runPublicUnitCli(process.argv.slice(2), {
  cwd: process.cwd(),
  contractsDir: path.resolve(scriptDir, '..', 'skills'),
});
process.stdout.write(`${output}\n`);
const result = JSON.parse(output.split(/\r?\n/).findLast(line => line.startsWith('RESULT ')).slice(7));
process.exitCode = result.code;
