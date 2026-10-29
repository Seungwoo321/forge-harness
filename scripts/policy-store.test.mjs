import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdapters } from './lib/adapters.mjs';
import { detectPolicyClues, resolveStoredPolicy, setPolicy } from './lib/policy-store.mjs';
import { runPolicyCli } from './policy.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, '.git', 'work-state');
  await mkdir(projectRoot, { recursive: true });
  return { root, projectRoot, stateRoot, adapters: createAdapters({ clock: () => new Date('2026-01-02T03:04:05.000Z'), id: () => 'change-1' }) };
}

test('policy detect reads clues without creating or changing files', async t => {
  const { root, projectRoot, stateRoot } = await fixture(t);
  const before = await readdir(root);
  const clues = await detectPolicyClues({ projectRoot, stateRoot, remote: 'git@example.test:org/app.git' });
  assert.equal(clues.remote, 'git@example.test:org/app.git');
  assert.deepEqual(await readdir(root), before);
});

test('non-interactive resolve uses conservative default and interactive resolve blocks', async t => {
  const { projectRoot, stateRoot } = await fixture(t);
  await assert.rejects(() => resolveStoredPolicy({ stateRoot, projectRoot }), error => error.code === 'POLICY_UNSET');
  const result = await resolveStoredPolicy({ stateRoot, projectRoot, nonInteractive: true });
  assert.equal(result.policy.goal.class, 'task');
  assert.equal(result.policySources['goal.class'], 'unconfirmed-default');
});

test('policy set validates, stores confirmation provenance, and logs requested changes', async t => {
  const { projectRoot, stateRoot, adapters } = await fixture(t);
  const options = { level: 'project', projectRoot, stateRoot, adapters };
  await setPolicy({ ...options, draft: { goal: { class: 'task' }, delivery: 'none' } });
  const result = await setPolicy({ ...options, change: true, reason: 'release preparation', userInputRef: 'conversation:confirmed', draft: { goal: { class: 'product-live' }, retry: { maxPerSignature: 3 } } });
  const saved = JSON.parse(await readFile(path.join(stateRoot, 'policy.json'), 'utf8'));
  const history = await readFile(path.join(stateRoot, 'policy-changes.ndjson'), 'utf8');
  assert.equal(saved.confirmedBy, 'user');
  assert.equal(saved.confirmedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(result.policySources['goal.class'], 'project');
  assert.match(history, /"before"/);
  assert.match(history, /"reason":"release preparation"/);
  await assert.rejects(() => setPolicy({ ...options, draft: { goal: { class: 'task' }, retry: { maxPerResolver: 9 } } }), /unsupported fields|invalid retry/);
  await assert.rejects(() => setPolicy({ ...options, level: 'workspace', workspaceRoot: path.join(projectRoot, 'child'), draft: { goal: { class: 'task' } } }));
});

test('policy CLI reports POLICY_UNSET and accepts non-interactive mode', async t => {
  const { projectRoot, stateRoot } = await fixture(t);
  const base = ['policy', 'resolve', '--state-root', stateRoot, '--project-root', projectRoot];
  const blocked = JSON.parse((await runPolicyCli(base)).split('RESULT ')[1]);
  const fallback = JSON.parse((await runPolicyCli([...base, '--non-interactive'])).split('RESULT ')[1]);
  assert.equal(blocked.code, 3);
  assert.equal(blocked.error, 'POLICY_UNSET');
  assert.equal(fallback.policySources['goal.class'], 'unconfirmed-default');
  const notice = await runPolicyCli(['policy', 'startup-notice', '--state-root', stateRoot, '--project-root', projectRoot]);
  assert.match(notice.split('\n')[0], /run policy-setup/);
});

test('registered SessionStart hook emits one notice without prompting or writing', async t => {
  const { projectRoot } = await fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
  const hookConfig = JSON.parse(await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const hookCommand = hookConfig.hooks.SessionStart[0].hooks[0].command;
  assert.match(hookCommand, /policy-startup-hook\.mjs/);
  const output = execFileSync(process.execPath, [new URL('./policy-startup-hook.mjs', import.meta.url).pathname], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(output, 'Work policy is not configured; run policy-setup before starting a unit.\n');
  await assert.rejects(() => readFile(path.join(projectRoot, '.git', 'work-state', 'policy.json')));
});
