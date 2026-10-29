import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapters } from '../scripts/lib/adapters.mjs';

// Exercise only the public CLI in a disposable project, never the caller's checkout.
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'first-run-')));
const { command } = createAdapters({ repositoryRoot: cwd });
async function run(binary, args) {
  const result = await command(binary, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout;
}
async function cli(script, args) {
  const output = await run(process.execPath, [path.join(packageRoot, 'scripts', script), ...args]);
  const result = JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  assert.equal(result.code, 0);
  process.stdout.write(`${result.summary}\n`);
  return result;
}
try {
  await run('git', ['init', '--quiet']);
  await writeFile(path.join(cwd, 'greeting.txt'), 'Hello\n');
  await run('git', ['add', 'greeting.txt']);
  await run('git', ['-c', 'user.name=Example', '-c', 'user.email=dev@example.com', 'commit', '--quiet', '-m', 'Initial greeting']);
  await cli('policy.mjs', ['policy', 'set', '--level', 'project', '--draft', path.join(packageRoot, 'examples/policy.json')]);
  const started = await cli('unit.mjs', ['unit', 'start', 'greeting', '--request', path.join(packageRoot, 'examples/request.json')]);
  assert.equal(started.state, 'Scoped');
  const opened = await cli('unit.mjs', ['unit', 'stage', 'open', 'greeting', 'scope']);
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  assert.equal(input.stage, 'scope');
  // This fixed example submission checks the envelope; it is not a model-generated scope.
  const output = path.join(cwd, 'scope-output.json');
  await writeFile(output, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'example-scope-1',
    status: 'done', summary: 'Scope the greeting change',
    acceptance: [{ id: 'AC-1', text: 'greeting.txt contains Hello world.' }],
    scopePaths: ['greeting.txt'], assumptions: [], openDecisions: [],
  }));
  await cli('unit.mjs', ['unit', 'stage', 'submit', 'greeting', 'scope', '--output', output]);
  const implementation = await cli('unit.mjs', ['unit', 'stage', 'open', 'greeting', 'implement']);
  const nextInput = JSON.parse(await readFile(implementation.input, 'utf8'));
  assert.equal(nextInput.data.acceptance[0].id, 'AC-1');
  assert.deepEqual(nextInput.data.scopePaths, ['greeting.txt']);
  process.stdout.write('PASS: packaged policy, scope submission, and implement input\n');
} finally {
  await rm(cwd, { recursive: true, force: true });
}
