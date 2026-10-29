import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runUnitCli } from './lib/unit-driver.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { gateFingerprint } from './lib/evidence.mjs';
import { executeDelivery } from './lib/delivery-flow.mjs';

const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const args = { resource: 'drafts', selectionDigest: 'selection-1' };
const gate = { id: 'tests', command: ['test'], format: 'exec', files: [{ path: 'source', content: 'same' }] };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'effect-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUnitStateStore(root), ledger = createLedgerStore(root);
  await store.create({ schema: 'harness.unit/1', unit: 'demo', revision: 0, kind: 'impl', state: 'Accepted',
    policy: { goal: { class: 'product-prelaunch' }, delivery: 'none', review: { mode: 'none', by: 'session', triggers: [] } },
    accepted: { head: 'h1', contentFingerprint: 'c1' }, acceptance: [{ id: 'AC-1', status: 'open' }],
    evidence: [{ gate: 'tests', fingerprint: gateFingerprint(gate), status: 'passed', exit: 0, covers: ['AC-1'] }],
    approvals: [{ id: 'allow', effect: 'data.delete', argsDigest: effectArgsDigest(args), head: 'h1',
      reason: 'remove owned drafts', userInputRef: 'user-1', approvedAt: '2026-10-29T00:00:00Z' }],
  });
  await writeFile(path.join(root, 'args.json'), JSON.stringify(args));
  const prepared = latch();
  let applied = 0;
  const target = { head: 'h1', contentFingerprint: 'c1' };
  const adapters = { now: () => '2026-10-29T00:00:00Z', git: { inspectUnit: async () => ({ ...target }) },
    provider: { verifyUserInput: async input => ({ ...input, verified: true }) },
    effectContext: async () => { prepared.resolve(); return { resourceOwned: true, productOwned: true, inScope: true,
      operational: false, irreversible: true, containsSecret: false, forbiddenCommand: false }; },
    effect: { execute: async () => { applied++; return { applied: true }; }, verify: async () => ({ status: 'unknown' }) },
    gates: { describe: async () => gate, run: async () => ({ exit: 0, ok: true, covers: ['AC-2'], report: '{}', reportPath: 'report.json' }) },
  };
  const call = async argv => JSON.parse((await runUnitCli(argv, { cwd: root, stateRoot: root, adapters })).split('\n').at(-1).slice(7));
  return { root, store, ledger, prepared, adapters, target, applied: () => applied, call,
    effect: () => call(['unit', 'effect', 'demo', '--effect', 'data.delete', '--args', 'args.json', '--approval', 'allow']) };
}

test('PUBLIC-E4-INVALID-APPROVAL: queued E4 consumes current Unit authority after ledger contention', async t => {
  for (const change of ['divergent', 'failure', 'Blocked', 'Stopped', 'head', 'content', 'approval', 'unverified']) {
    await t.test(change, async t => {
      const f = await fixture(t), holding = latch(), release = latch();
      t.after(() => release.resolve());
      const lock = f.ledger.withLock('demo', async () => { holding.resolve(); await release.promise; });
      await holding.promise;
      const effect = f.effect();
      await f.prepared.promise;
      if (change === 'divergent' || change === 'failure') {
        if (change === 'failure') f.adapters.gates.run = async () => ({ exit: 1, ok: false, failureClass: 'product', covers: [], report: '{}', reportPath: 'report.json' });
        await f.call(['evidence', 'rerun', 'demo', '--gate', 'tests']);
        assert.equal((await f.store.read('demo')).accepted, null);
      } else if (['Blocked', 'Stopped'].includes(change)) await f.store.transition('demo', change);
      else if (change === 'head') f.target.head = 'h2';
      else if (change === 'content') f.target.contentFingerprint = 'c2';
      else if (change === 'approval') await f.store.update('demo', current => ({ ...current, approvals: [] }));
      else f.adapters.provider.verifyUserInput = async input => ({ ...input, verified: false });
      release.resolve();
      await lock;
      assert.equal((await effect).error, 'EFFECT_APPROVAL_REQUIRED');
      assert.equal(f.applied(), 0);
      assert.deepEqual(await f.ledger.withLock('demo', entries => entries.read()), []);
    });
  }
});

test('PUBLIC-E4-APPROVAL-BOUND: execution custody serializes later revocation and preserves duplicate handling', async t => {
  const f = await fixture(t), executing = latch(), release = latch();
  t.after(() => release.resolve());
  const order = [];
  f.adapters.effect.execute = async () => {
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'units/demo/.lock'), 'utf8')).pid, process.pid);
    const rows = await readFile(path.join(f.root, 'units/demo/ledger.ndjson'), 'utf8');
    assert.equal(JSON.parse(rows.trim()).event, 'intent');
    executing.resolve();
    await release.promise;
    order.push('executed');
    return { applied: true };
  };
  const effect = f.effect();
  await executing.promise;
  const revoking = f.store.update('demo', current => {
    order.push('revoked');
    return { ...current, accepted: null, state: 'SelfGated' };
  });
  release.resolve();
  assert.equal((await effect).status, 'completed');
  await revoking;
  assert.deepEqual(order, ['executed', 'revoked']);
  const record = await f.store.read('demo');
  assert.equal(record.accepted, null);
  assert.equal(record.revision, 2);
  assert.equal((await f.effect()).error, 'EFFECT_DENIED');
  const rows = await f.ledger.withLock('demo', entries => entries.read());
  assert.deepEqual(rows.map(row => row.event), ['intent', 'result']);
  const normal = await fixture(t);
  assert.equal((await normal.effect()).status, 'completed');
  assert.equal((await normal.effect()).status, 'duplicate');
  assert.equal(normal.applied(), 1);
});

test('PUBLIC-E4-INVALID-APPROVAL: irreversible delivery consumes the same Unit boundary after ledger contention', async t => {
  const f = await fixture(t), preparing = latch(), prepared = latch(), holding = latch(), release = latch();
  t.after(() => { prepared.resolve(); release.resolve(); });
  Object.assign(f.target, { repo: 'demo/repo', branch: 'feature', tree: 't1', indexTree: 't1', headTree: 't1', base: 'main' });
  const pushArgs = { repo: 'demo/repo', branch: 'feature', head: 'h1' };
  await f.store.update('demo', current => ({ ...current, accepted: { ...f.target },
    policy: { ...current.policy, delivery: 'push' },
    approvals: [{ ...current.approvals[0], effect: 'git.push', argsDigest: effectArgsDigest(pushArgs) }] }));
  f.adapters.git.deliveryContext = async () => {
    preparing.resolve();
    await prepared.promise;
    return f.adapters.effectContext();
  };
  f.adapters.git.execute = () => { assert.fail('revoked delivery must not execute'); };
  f.adapters.git.verify = async () => ({ status: 'unknown' });
  const delivering = executeDelivery({ stateRoot: f.root, store: f.store, unit: 'demo', requestedDelivery: 'push',
    delivery: { approvalRef: 'allow' }, adapters: f.adapters });
  await preparing.promise;
  const lock = f.ledger.withLock('demo', async () => { holding.resolve(); await release.promise; });
  await holding.promise;
  await f.call(['evidence', 'rerun', 'demo', '--gate', 'tests']);
  assert.equal((await f.store.read('demo')).accepted, null);
  const denied = assert.rejects(delivering, { code: 'EFFECT_APPROVAL_REQUIRED' });
  prepared.resolve();
  release.resolve();
  await lock;
  await denied;
  assert.deepEqual(await f.ledger.withLock('demo', entries => entries.read()), []);
});
