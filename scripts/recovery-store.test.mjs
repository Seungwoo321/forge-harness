import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecoveryStore, resumeUnitFailure } from './lib/recovery-store.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t, unit = 'unit-recovery', state = 'Implementing') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'work-state');
  const store = createUnitStateStore(stateRoot);
  await store.create({
    schema: 'harness.unit/1', unit, revision: 0, kind: 'impl', state, blockedFrom: state === 'Blocked' ? 'SelfGated' : null,
    stoppedFrom: state === 'Stopped' ? 'InReview' : null, request: 'request', canon: [], policy: { goal: { class: 'task' } },
    tracker: null, isolation: 'shared', stages: [], acceptance: [], evidence: [], openDecisions: [], failures: [],
  });
  let sequence = 0;
  const adapters = { id: () => `failure-${++sequence}`, now: () => '2026-01-02T03:04:05.000Z' };
  return { root, stateRoot, store, recovery: createRecoveryStore(stateRoot), adapters };
}

test('failure records and cause budgets persist across occurrences', async t => {
  const { stateRoot, store, recovery, adapters } = await fixture(t);
  const failure = { class: 'product', failurePoint: 'src/worker.mjs:4', reason: 'bad response' };
  const first = await recovery.record({ store, unit: 'unit-recovery', failure, adapters });
  await assert.rejects(() => recovery.reserveRetry({ causeKey: first.failure.causeKey }), { code: 'DIAGNOSIS_REQUIRED' });
  const second = await recovery.record({ store, unit: 'unit-recovery', failure, adapters });
  await recovery.reserveRetry({ causeKey: first.failure.causeKey });
  const third = await recovery.record({ store, unit: 'unit-recovery', failure, adapters });
  assert.deepEqual([first.decision.action, second.decision.action, third.decision.action], ['retry', 'diagnose', 'stop']);
  assert.equal((await store.read('unit-recovery')).state, 'Stopped');
  const causes = await recovery.causes();
  assert.equal(causes[failure.failurePoint + '|' + failure.reason].retries, 2);
  assert.equal(causes[failure.failurePoint + '|' + failure.reason].occurrences, 3);
  const stored = await recovery.readFailure('unit-recovery', first.failure.id);
  assert.equal(stored.class, 'product');
  assert.match(first.reference.digest, /^sha256:/);
  assert.ok(await readFile(path.join(stateRoot, first.reference.path), 'utf8'));
});

test('user-domain failure stops without reserving a resolver; harness failure reserves one', async t => {
  const user = await fixture(t, 'user-unit');
  const userResult = await user.recovery.record({ store: user.store, unit: 'user-unit', failure: { class: 'user-domain', failurePoint: 'decision', reason: 'needs user choice' }, adapters: user.adapters });
  assert.equal(userResult.decision.action, 'defer');
  assert.equal(userResult.record.state, 'Stopped');
  assert.equal(userResult.decision.cause.resolverAttempts, 0);

  const harness = await fixture(t, 'harness-unit');
  const harnessResult = await harness.recovery.record({ store: harness.store, unit: 'harness-unit', failure: { class: 'harness', failurePoint: 'runner', reason: 'contract rejected' }, adapters: harness.adapters });
  assert.equal(harnessResult.decision.action, 'resolver');
  assert.equal(harnessResult.record.state, 'Blocked');
  assert.equal(harnessResult.decision.cause.activeResolver, true);
});

test('unknown failures cannot reserve a retry until diagnosis is persisted', async t => {
  const { stateRoot, store, recovery, adapters } = await fixture(t, 'unit-unknown');
  const failure = { failurePoint: 'runner:4', reason: 'unexpected result' };
  const recorded = await recovery.record({ store, unit: 'unit-unknown', failure, adapters });
  assert.equal(recorded.decision.action, 'diagnose');
  assert.equal((await recovery.causes())[recorded.failure.causeKey].lastAction, 'awaiting-diagnosis');
  await assert.rejects(() => recovery.reserveRetry({ causeKey: recorded.failure.causeKey }), { code: 'DIAGNOSIS_REQUIRED' });

  const confirmed = await createRecoveryStore(stateRoot).confirmDiagnosis({
    causeKey: recorded.failure.causeKey, classification: 'product',
  });
  assert.equal(confirmed.class, 'product');
  assert.equal((await createRecoveryStore(stateRoot).causes())[recorded.failure.causeKey].lastAction, 'diagnose');
  const retry = await createRecoveryStore(stateRoot).reserveRetry({ causeKey: recorded.failure.causeKey });
  assert.equal(retry.action, 'retry');
  await assert.rejects(() => createRecoveryStore(stateRoot).reserveRetry({ causeKey: recorded.failure.causeKey }), { code: 'DIAGNOSIS_REQUIRED' });
});

test('resume uses persisted origin state and blocks when an effect intent is unresolved', async t => {
  const { store } = await fixture(t, 'unit-resume', 'Blocked');
  const snapshot = { git: { head: 'head-1', contentFingerprint: 'sha256:current', checkpoints: {}, worktreeDiff: [], indexDiff: [] }, evidence: [], currentFingerprints: {} };
  const resumed = await resumeUnitFailure({ store, unit: 'unit-resume', snapshot });
  assert.equal(resumed.recovery.action, 'resume');
  assert.equal(resumed.record.state, 'SelfGated');
  assert.equal(resumed.stage, 'gates');

  const blocked = await fixture(t, 'unit-effect-resume', 'Blocked');
  const pending = await resumeUnitFailure({ store: blocked.store, unit: 'unit-effect-resume', snapshot: { ...snapshot, ledger: [{ event: 'intent', seq: 1, key: 'key-1' }] } });
  assert.equal(pending.recovery.action, 'reconcile-effect');
  assert.equal(pending.record.state, 'Blocked');
});

test('unit fail CLI records a user-domain stop without running external commands', async t => {
  const { stateRoot, store, root, adapters } = await fixture(t, 'unit-cli-fail');
  const input = path.join(root, 'failure.json');
  await writeFile(input, JSON.stringify({ class: 'user-domain', failurePoint: 'approval', reason: 'user decision required' }));
  let commands = 0;
  const output = await runUnitCli(['unit', 'fail', 'unit-cli-fail', '--failure', input], {
    stateRoot,
    adapters: { ...adapters, command: async () => { commands += 1; throw new Error('unexpected command'); } },
  });
  const result = JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
  assert.equal(result.code, 3);
  assert.equal(result.action, 'defer');
  assert.equal((await store.read('unit-cli-fail')).state, 'Stopped');
  assert.equal(commands, 0);
});

test('unit resume CLI returns to the persisted origin stage from an explicit adapter snapshot', async t => {
  const { stateRoot, store, root } = await fixture(t, 'unit-cli-resume', 'Blocked');
  const snapshot = path.join(root, 'resume.json');
  await writeFile(snapshot, JSON.stringify({
    git: { head: 'head-1', contentFingerprint: 'sha256:current', checkpoints: {}, worktreeDiff: [], indexDiff: [] },
    evidence: [], currentFingerprints: {},
  }));
  const output = await runUnitCli(['unit', 'resume', 'unit-cli-resume', '--snapshot', snapshot], { stateRoot, adapters: {} });
  const result = JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
  assert.equal(result.code, 0);
  assert.equal(result.stage, 'gates');
  assert.equal((await store.read('unit-cli-resume')).state, 'SelfGated');
});

test('fresh CLI process resumes from the persisted Unit Record and ledger without changing retry budgets', async t => {
  const { stateRoot, store, recovery, adapters, root } = await fixture(t, 'unit-process-restart');
  const failure = { class: 'product', failurePoint: 'tests:unit', reason: 'assertion failure' };
  const recorded = await recovery.record({ store, unit: 'unit-process-restart', failure, adapters });
  assert.equal(recorded.decision.action, 'retry');
  assert.equal((await recovery.causes())[recorded.failure.causeKey].retries, 1);
  const unitDirectory = path.join(stateRoot, 'units', 'unit-process-restart');
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(path.join(unitDirectory, 'ledger.ndjson'), `${JSON.stringify({ event: 'intent', unit: 'unit-process-restart', seq: 1, key: 'pending-effect' })}\n`);
  const snapshot = path.join(root, 'fresh-process-snapshot.json');
  await writeFile(snapshot, JSON.stringify({
    git: { head: 'head-1', checkpoints: {}, worktreeDiff: [], indexDiff: [] },
    evidence: [], currentFingerprints: {},
  }));

  const child = spawnSync(process.execPath, [
    path.join(repo, 'scripts/unit.mjs'), 'unit', 'resume', 'unit-process-restart',
    '--state-root', stateRoot, '--project-root', root, '--snapshot', snapshot,
  ], { cwd: repo, encoding: 'utf8' });
  assert.equal(child.status, 3, child.stderr);
  const resumed = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
  assert.equal(resumed.recovery.action, 'reconcile-effect');
  assert.equal((await store.read('unit-process-restart')).state, 'Implementing');
  assert.equal((await createRecoveryStore(stateRoot).causes())[recorded.failure.causeKey].retries, 1);
  const ledger = (await readFile(path.join(unitDirectory, 'ledger.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.map(item => item.event), ['intent']);
});

test('unit retry CLI uses the persisted policy limit after diagnosis', async t => {
  const { stateRoot, store, recovery, adapters } = await fixture(t, 'unit-cli-retry');
  const failure = { class: 'product', failurePoint: 'gate:test', reason: 'assertion failed' };
  await store.update('unit-cli-retry', current => ({ ...current, policy: { goal: { class: 'task' }, retry: { maxPerSignature: 3, maxResolver: 2 } } }));
  const input = path.join(stateRoot, 'failure.json');
  await writeFile(input, JSON.stringify(failure));
  const run = async args => JSON.parse((await runUnitCli(args, { stateRoot, adapters })).split('\n').at(-1).slice('RESULT '.length));
  const first = await run(['unit', 'fail', 'unit-cli-retry', '--failure', input]);
  const second = await run(['unit', 'fail', 'unit-cli-retry', '--failure', input]);
  assert.equal(first.action, 'retry');
  assert.equal(second.action, 'diagnose');
  const retry = await run(['unit', 'retry', 'unit-cli-retry', '--cause-key', second.causeKey]);
  assert.equal(retry.code, 0);
  assert.equal(retry.action, 'retry');
  assert.equal(retry.cause.retries, 2);
  const third = await run(['unit', 'fail', 'unit-cli-retry', '--failure', input]);
  assert.equal(third.action, 'diagnose');
});
