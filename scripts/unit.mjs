#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPublicUnitCli } from './lib/runtime-adapters.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const output = await runPublicUnitCli(process.argv.slice(2), {
  cwd: process.cwd(),
  contractsDir: path.resolve(scriptDir, '..', 'skills'),
});
process.stdout.write(`${output}\n`);
const result = JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
process.exitCode = result.code;
