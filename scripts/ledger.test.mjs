import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedgerStore, executeEffect } from './lib/ledger.mjs';

const taskPolicy = { goal: { class: 'task' }, authority: { allow: [], deny: [] }, delivery: 'commit' };
const commitArgs = { repo: 'example/repo', branch: 'feature', tree: 'tree-1', parent: 'parent-1' };

async function fixture() {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-ledger-'));
  let tick = 0;
  return {
    stateRoot,
    store: createLedgerStore(stateRoot),
    adapter: {
      now: () => `time-${++tick}`,
      execute: async () => ({ ok: true }),
      verify: async () => ({ status: 'unknown' }),
    },
    async cleanup() { await rm(stateRoot, { recursive: true, force: true }); },
  };
}

test('authorized effect appends intent before execution and result after', async () => {
  const f = await fixture();
  try {
    const order = [];
    f.adapter.execute = async () => {
      const rows = (await readFile(path.join(f.stateRoot, 'units', 'UNIT-1', 'ledger.ndjson'), 'utf8')).trim().split('\n');
      order.push(JSON.parse(rows[0]).event);
      return { commit: 'commit-1' };
    };
    const result = await executeEffect({
      unit: 'UNIT-1', effect: 'git.commit', args: commitArgs, policy: taskPolicy,
      context: { inScope: true }, store: f.store, adapter: f.adapter,
    });
    order.push(result.status);
    const rows = (await readFile(path.join(f.stateRoot, 'units', 'UNIT-1', 'ledger.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(order, ['intent', 'completed']);
    assert.deepEqual(rows.map(row => row.event), ['intent', 'result']);
    assert.equal(rows[0].key, rows[1].key);
    assert.equal(rows[0].class, 'E2');
  } finally { await f.cleanup(); }
});

test('same key returns recorded result without executing again', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.adapter.execute = async () => { calls += 1; return { commit: 'commit-1' }; };
    const input = { unit: 'UNIT-2', effect: 'git.commit', args: commitArgs, policy: taskPolicy, context: { inScope: true }, store: f.store, adapter: f.adapter };
    const first = await executeEffect(input);
    const second = await executeEffect(input);
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'duplicate');
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('closed, merged, and missing pull requests are replaced while same-head open requests are reused', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.adapter.execute = async () => ({ pr: `pr-${++calls}` });
    const input = {
      unit: 'UNIT-PR', effect: 'pr.create',
      args: { repo: 'example/repo', branch: 'feature', head: 'head-1', base: 'main' },
      policy: { ...taskPolicy, delivery: 'pr' }, context: { inScope: true, explicitUserInstruction: true },
      store: f.store, adapter: f.adapter,
    };
    assert.equal((await executeEffect(input)).result.pr, 'pr-1');
    for (const status of ['closed', 'merged', 'not-found']) {
      f.adapter.verify = async () => ({ status });
      const replacement = await executeEffect(input);
      assert.equal(replacement.result.pr, `pr-${calls}`);
    }
    f.adapter.verify = async () => ({ status: 'open', ...input.args, result: { pr: 'pr-4' } });
    const reused = await executeEffect(input);
    assert.equal(reused.status, 'duplicate');
    assert.equal(reused.result.pr, 'pr-4');
    assert.equal(calls, 4);
  } finally { await f.cleanup(); }
});

test('intent without result is verified and never blindly retried', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.adapter.execute = async () => { calls += 1; throw new Error('connection lost after request'); };
    const input = { unit: 'UNIT-3', effect: 'git.commit', args: commitArgs, policy: taskPolicy, context: { inScope: true }, store: f.store, adapter: f.adapter };
    assert.equal((await executeEffect(input)).status, 'uncertain');
    f.adapter.verify = async () => ({ status: 'absent', verify: { adapter: 'git', operation: 'inspect' } });
    assert.equal((await executeEffect(input)).status, 'uncertain');
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('registered verifier can reconcile a completed uncertain effect', async () => {
  const f = await fixture();
  try {
    f.adapter.execute = async () => { throw new Error('response lost'); };
    const input = { unit: 'UNIT-4', effect: 'git.commit', args: commitArgs, policy: taskPolicy, context: { inScope: true }, store: f.store, adapter: f.adapter };
    assert.equal((await executeEffect(input)).status, 'uncertain');
    f.adapter.verify = async () => ({ status: 'completed', result: { commit: 'commit-4' }, verify: { adapter: 'git', operation: 'inspect' } });
    const result = await executeEffect(input);
    assert.equal(result.status, 'reconciled');
    assert.deepEqual(result.result, { commit: 'commit-4' });
  } finally { await f.cleanup(); }
});

test('uncertain PR reconciliation accepts only the exact open repository branch head and base', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const args = { repo: 'example/repo', branch: 'feature', head: 'head-1', base: 'main' };
    f.adapter.execute = async () => { calls += 1; throw new Error('lost response'); };
    const input = { unit: 'UNIT-PR-UNKNOWN', effect: 'pr.create', args,
      policy: { ...taskPolicy, delivery: 'pr' }, context: { explicitUserInstruction: true }, store: f.store, adapter: f.adapter };
    assert.equal((await executeEffect(input)).status, 'uncertain');
    for (const field of Object.keys(args)) {
      f.adapter.verify = async () => ({ status: 'open', ...args, [field]: 'other', result: { pr: 1 } });
      assert.equal((await executeEffect(input)).status, 'uncertain');
    }
    f.adapter.verify = async () => ({ status: 'open', ...args, result: { pr: 1 }, verify: { adapter: 'repository', operation: 'pr.inspect' } });
    assert.equal((await executeEffect(input)).status, 'reconciled');
    assert.equal(calls, 1);
    const rows = await f.store.withLock(input.unit, ledger => ledger.read());
    assert.equal(rows.filter(row => row.event === 'intent').length, 1);
    assert.equal(rows.filter(row => row.event === 'verification').length, 4);
  } finally { await f.cleanup(); }
});

test('denied and unregistered effects create no ledger entry', async () => {
  const f = await fixture();
  try {
    await assert.rejects(executeEffect({
      unit: 'UNIT-5', effect: 'git.commit', args: commitArgs, policy: taskPolicy,
      context: { inScope: false }, store: f.store, adapter: f.adapter,
    }), { code: 'EFFECT_DENIED' });
    await assert.rejects(executeEffect({
      unit: 'UNIT-5', effect: 'unknown.effect', args: {}, policy: taskPolicy,
      store: f.store, adapter: f.adapter,
    }), { code: 'EFFECT_UNREGISTERED' });
    await assert.rejects(executeEffect({
      unit: 'UNIT-5', effect: 'git.push', args: { repo: 'example/repo', branch: 'feature', head: 'head-1' },
      policy: { ...taskPolicy, delivery: 'push' }, context: { inScope: true }, approvalRef: 'unverified-reference',
      store: f.store, adapter: f.adapter,
    }), { code: 'EFFECT_DENIED' });
    await assert.rejects(readFile(path.join(f.stateRoot, 'units', 'UNIT-5', 'ledger.ndjson')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('exact-open PR verification replaces a historical PR identity before reuse', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const args = { repo: 'example/repo', branch: 'feature', head: 'head-1', base: 'main' };
    f.adapter.execute = async () => { calls += 1; return { pr: 1 }; };
    const input = { unit: 'UNIT-PR-REPLACED', effect: 'pr.create', args, policy: { ...taskPolicy, delivery: 'pr' },
      context: { explicitUserInstruction: true }, store: f.store, adapter: f.adapter };
    assert.equal((await executeEffect(input)).result.pr, 1);
    f.adapter.verify = async () => ({ status: 'open', ...args, result: { pr: 2 }, verify: { adapter: 'repository', operation: 'pr.inspect', args: { pr: 2 } } });
    const current = await executeEffect(input);
    assert.equal(current.status, 'reconciled');
    assert.equal(current.result.pr, 2);
    assert.equal((await executeEffect(input)).result.pr, 2);
    assert.equal(calls, 1);
    const rows = await f.store.withLock(input.unit, ledger => ledger.read());
    assert.equal(rows.findLast(row => row.event === 'result').result.pr, 2);
  } finally { await f.cleanup(); }
});
