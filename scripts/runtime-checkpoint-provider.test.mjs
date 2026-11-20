import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPublicUnitCli } from './lib/runtime-adapters.mjs';

const result = output => JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));

test('a runtime checkpoint provider replaces the core checkpoint adapter and must supply both operations', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const calls = path.join(root, 'calls.json');
  const module = complete => `import { appendFileSync } from 'node:fs';
export function createRuntimeAdapters() {
  return { checkpoint: { async createCheckpoint(args) { appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ op: 'create', head: args.head, ref: args.ref }) + '\\n');
      return { ref: args.ref, commit: ${JSON.stringify(head)}, head: args.head ?? ${JSON.stringify(head)}, excluded: [], worktreeChanged: false, indexChanged: false }; }${complete ? `,
    async inspectChanges() { return { head: ${JSON.stringify(head)}, tree: 'tree', firstCheckpointDiff: [], attemptDiff: [] }; }` : ''} } };
}`;
  const request = path.join(root, 'start.json');
  await writeFile(request, JSON.stringify({ kind: 'impl', request: { text: 'Change', userInputRef: 'u' }, policyOverrides: { goal: { class: 'task' }, delivery: 'none' } }));
  const stateRoot = path.join(root, '.git', 'work-state');
  const run = (args, provider) => runPublicUnitCli([...args, '--state-root', stateRoot, '--project-root', root, '--adapters', provider], { cwd: root });
  const incompleteProvider = path.join(root, 'incomplete.mjs'), provider = path.join(root, 'runtime.mjs');
  await writeFile(incompleteProvider, module(false));
  const incomplete = result(await run(['unit', 'start', 'demo', '--request', request, '--non-interactive'], incompleteProvider));
  assert.notEqual(incomplete.code, 0); assert.match(incomplete.message, /checkpoint provider requires createCheckpoint, inspectChanges/);
  await writeFile(provider, module(true));
  assert.equal(result(await run(['unit', 'start', 'demo', '--request', request, '--non-interactive'], provider)).code, 0);
  assert.equal(result(await run(['unit', 'stage', 'open', 'demo', 'scope'], provider)).code, 0);
  const recorded = (await import('node:fs')).readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(item => item.op), ['create']);
});
