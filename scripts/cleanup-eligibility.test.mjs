import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state'), worktree = path.join(root, 'worktree'), other = path.join(root, 'other');
  await mkdir(worktree); await mkdir(other);
  const store = createUnitStateStore(stateRoot), goals = createContinuityStore(stateRoot), ledgers = createLedgerStore(stateRoot);
  const owner = { runtime: 'cmux', sessionId: 'surface-1', incarnationId: 'tty:42:start', cwd: worktree };
  await store.create({ schema: 'harness.unit/1', unit: 'change', kind: 'impl', state: 'Closed', policy: { goal: { class: 'task' } }, continuity: { goalId: 'work' },
    stages: [], failures: [], evidence: [], accepted: { repo: 'example/repo', branch: 'feature/change', head: 'head', contentFingerprint: 'content' },
    sessionFinalization: { mode: 'complete', owner } });
  await store.create({ schema: 'harness.unit/1', unit: 'review-1', kind: 'review', targetUnit: 'change', state: 'Closed', policy: { goal: { class: 'task' } },
    continuity: { goalId: 'work' }, stages: [], failures: [], evidence: [], accepted: null, sessionFinalization: { mode: 'review', owner: { sessionId: 'surface-2' }, closeReceipt: { status: 'completed' } } });
  await goals.create({ goal: { id: 'work', objective: 'Ship', criteria: ['done'], remaining: ['change'], status: 'active' },
    policy: { runtime: 'cmux', provider: 'codex', account: '/example-account', model: 'model', effort: 'high', argv: ['codex'] }, source: { path: path.join(root, 'goal.md'), digest: `sha256:${'0'.repeat(64)}` } });
  const complete = () => goals.transaction('work', goal => ({ ...goal, revision: goal.revision + 1, goal: { ...goal.goal, remaining: [], status: 'complete' },
    completion: { unit: 'change', proof: [] }, reviews: [{ unit: 'review-1', targetUnit: 'change' }] }));
  await complete();
  const append = (unit, row) => ledgers.withLock(unit, ledger => ledger.append(row));
  await append('change', { event: 'intent', unit: 'change', effect: 'session.close', seq: 1, key: 'close-1', args: {} });
  await append('change', { event: 'result', unit: 'change', seq: 1, key: 'close-1', result: { closed: true, sessionId: owner.sessionId, incarnationId: owner.incarnationId } });
  const request = async (extra = {}) => ({ unit: 'change', expectedRevision: (await store.read('change')).revision, expectedGoalRevision: (await goals.read('work')).revision,
    repo: 'example/repo', branch: 'feature/change', worktree, ...extra });
  const run = async (body, cwd = root) => {
    const file = path.join(root, `request-${Math.random().toString(36).slice(2)}.json`); await writeFile(file, JSON.stringify(body));
    const output = await runUnitCli(['unit', 'cleanup-check', 'change', '--request', file], { cwd, stateRoot, adapters: {} });
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  };
  const snapshot = () => Promise.all(['units/change/unit.json', 'units/change/ledger.ndjson', 'goals/work/goal.json'].map(file => readFile(path.join(stateRoot, file), 'utf8')));
  return { root, stateRoot, worktree, other, store, goals, owner, append, request, run, snapshot };
}

test('AC-1 only the exact completed and closed lifecycle is eligible, read-only and stably bound', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const first = await f.run(await f.request()), second = await f.run(await f.request());
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.equal(first.eligibility.eligible, true);
  assert.equal(first.eligibility.eligibilityDigest, second.eligibility.eligibilityDigest);
  assert.deepEqual(await f.snapshot(), before);
});

test('AC-2 live InReview owner with an active goal refuses even after a merged clean delivery', async t => {
  const f = await fixture(t);
  await f.store.update('change', record => ({ ...record, state: 'InReview', sessionFinalization: null }));
  await f.goals.transaction('work', goal => ({ ...goal, revision: goal.revision + 1, goal: { ...goal.goal, remaining: ['change'], status: 'active' }, completion: null }));
  const result = await f.run(await f.request());
  assert.equal(result.error, 'CLEANUP_INELIGIBLE');
});

test('AC-3 missing binding, stale input, retained or unproven owners, effects, reviews and evidence location refuse', async t => {
  const cases = {
    'no worktree argument': async f => { const body = await f.request(); delete body.worktree; return [body, 'CLEANUP_REQUEST_INVALID']; },
    'stale unit revision': async f => [await f.request({ expectedRevision: 1 + (await f.store.read('change')).revision }), 'CLEANUP_INELIGIBLE'],
    'stale goal revision': async f => [await f.request({ expectedGoalRevision: 99 }), 'CLEANUP_INELIGIBLE'],
    'other worktree': async f => [await f.request({ worktree: f.other }), 'CLEANUP_INELIGIBLE'],
    'other branch': async f => [await f.request({ branch: 'feature/other' }), 'CLEANUP_INELIGIBLE'],
    'retained owner': async f => { await f.store.update('change', r => ({ ...r, sessionFinalization: { ...r.sessionFinalization, ownerRetained: true } })); return [await f.request(), 'CLEANUP_INELIGIBLE']; },
    'unresolved effect': async f => { await f.append('change', { event: 'intent', unit: 'change', effect: 'session.deliver', seq: 2, key: 'deliver-2', args: {} }); return [await f.request(), 'CLEANUP_INELIGIBLE']; },
    'unproven owner close': async f => { await f.store.update('change', r => ({ ...r, sessionFinalization: { ...r.sessionFinalization, owner: { ...f.owner, incarnationId: 'reused' } } })); return [await f.request(), 'CLEANUP_INELIGIBLE']; },
    'open review': async f => { await f.store.update('review-1', r => ({ ...r, state: 'InReview' })); return [await f.request(), 'CLEANUP_INELIGIBLE']; },
    'unmanaged unit': async f => { await f.store.update('change', r => ({ ...r, continuity: null })); return [await f.request(), 'CLEANUP_INELIGIBLE']; },
    'evidence inside target': async f => [await f.request({ worktree: f.root }), 'CLEANUP_INELIGIBLE'],
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const f = await fixture(t), [body, code] = await arrange(f), before = await f.snapshot();
    const result = await f.run(body);
    assert.equal(result.error, code, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(await f.snapshot(), before, name);
  }
});

test('AC-4 a later lifecycle change invalidates the earlier eligibility digest', async t => {
  const f = await fixture(t), first = await f.run(await f.request());
  await f.append('change', { event: 'tracker-note', unit: 'change', seq: 3, key: 'note' });
  const second = await f.run(await f.request());
  assert.equal(second.code, 0);
  assert.notEqual(second.eligibility.eligibilityDigest, first.eligibility.eligibilityDigest);
});
