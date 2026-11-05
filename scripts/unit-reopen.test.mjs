import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

async function fixture(t, state) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-reopen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'common.git', 'work-state');
  const store = createUnitStateStore(stateRoot);
  await store.create({ schema: 'harness.unit/1', unit: 'u1', revision: 1, kind: 'impl', state, request: 'request', canon: [],
    policy: { goal: { class: 'task' } }, tracker: null, isolation: 'shared', stages: [], acceptance: [], openDecisions: [],
    accepted: { head: 'h', contentFingerprint: 'c' }, reviewDecision: { head: 'h' }, reviewedHead: 'h', verdict: 'ship' });
  const run = async request => {
    const file = path.join(root, 'reopen.json'); await writeFile(file, JSON.stringify(request));
    const output = await runUnitCli(['unit', 'reopen', 'u1', '--request', file], { stateRoot, adapters: { now: () => '2026-01-02T03:04:05.000Z' } });
    return JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
  };
  return { store, run };
}

test('a remote failure after acceptance reopens the unit for implementation and clears acceptance', async t => {
  const { store, run } = await fixture(t, 'Accepted');
  const result = await run({ expectedRevision: 1, reason: 'remote CI tests failed', evidence: 'https://ci.example/pipeline/1' });
  assert.equal(result.code, 0, JSON.stringify(result));
  const record = await store.read('u1');
  assert.equal(record.state, 'Implementing');
  assert.equal(record.accepted, null); assert.equal(record.verdict, null); assert.equal(record.reviewedHead, null);
  assert.equal(record.reopenings[0].evidence, 'https://ci.example/pipeline/1');
  assert.equal((await run({ expectedRevision: 1, reason: 'again', evidence: 'x' })).error, 'STALE_REVISION');
});

test('reopen refuses units that are not accepted and requests without evidence', async t => {
  const { run } = await fixture(t, 'Implementing');
  assert.equal((await run({ expectedRevision: 1, reason: 'x', evidence: 'y' })).error, 'INVALID_TRANSITION');
  assert.notEqual((await run({ expectedRevision: 1, reason: 'x' })).code, 0);
});
