import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateFingerprint } from './lib/evidence.mjs';
import { selectProfile } from './lib/profile.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';

const gateFor = (id, content = 'source') => ({ id, format: 'exec', command: ['check', id], files: [{ path: id, content }] });
const pass = covers => ({ exit: 0, ok: true, covers, report: '{}', reportPath: 'report.json' });
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const decode = output => JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUnitStateStore(root);
  await store.create({ schema: 'harness.unit/1', unit: 'demo', revision: 0, kind: 'impl', state: 'Accepted',
    policy: { goal: { class: 'product-prelaunch' }, delivery: 'none', review: { mode: 'none', by: 'session', triggers: [] } },
    accepted: { head: 'h1', contentFingerprint: 'c1' }, acceptance: [{ id: 'AC-1', status: 'open' }],
    evidence: selectProfile('impl').gates.map(id => ({ gate: id, fingerprint: gateFingerprint(gateFor(id)), status: 'passed',
      exit: 0, failureClass: null, covers: ['AC-1'], digest: 'original' })),
  });
  const adapters = { git: { inspectUnit: async () => ({ head: 'h1', contentFingerprint: 'c1' }) },
    gates: { describe: async id => gateFor(id), run: async () => pass(['AC-1']) } };
  return { store, adapters, call: async args => decode(await runUnitCli(args, { cwd: root, stateRoot: root, adapters })) };
}

test('PUBLIC-EVIDENCE-RERUN-NONDETERMINISM: late matching and changed-input runs retain atomic comparison history', async t => {
  for (const changedInput of [false, true]) await t.test(String(changedInput), async t => {
    const f = await fixture(t);
    const started = latch(), release = latch();
    let runs = 0;
    f.adapters.gates.run = async () => {
      if (++runs === 1) { started.resolve(); await release.promise; return pass(['AC-1']); }
      return pass(['AC-2']);
    };
    const slow = f.call(['evidence', 'rerun', 'demo', '--gate', 'tests']);
    t.after(() => release.resolve());
    await started.promise;
    assert.equal((await f.call(['evidence', 'rerun', 'demo', '--gate', 'tests'])).nondeterministic, true);
    if (changedInput) {
      f.adapters.gates.describe = async id => gateFor(id, 'changed');
      f.adapters.gates.run = async () => pass(['AC-1']);
      assert.equal((await f.call(['unit', 'accept', 'demo'])).code, 0);
      f.adapters.gates.describe = async id => gateFor(id);
    }
    release.resolve();
    assert.equal((await slow).nondeterministic, true);
    const record = await f.store.read('demo');
    const evidence = record.evidence.find(item => item.gate === 'tests');
    assert.equal(evidence.status, 'nondeterministic');
    assert.equal(evidence.comparisonHistory.find(item => item.fingerprint === gateFingerprint(gateFor('tests'))).nondeterministic, true);
    if (changedInput) assert.ok(evidence.comparisonHistory.some(item => item.fingerprint === gateFingerprint(gateFor('tests', 'changed'))));
    assert.equal(record.accepted, null);
    assert.equal((await f.call(['unit', 'accept', 'demo'])).code, 1);
    assert.equal((await f.store.read('demo')).state, 'SelfGated');
  });
});

test('PUBLIC-EVIDENCE-RERUN-NONDETERMINISM: acceptance commit rechecks evidence changed after gate reuse', async t => {
  const f = await fixture(t);
  const checked = latch(), release = latch();
  let inspections = 0;
  f.adapters.git.inspectUnit = async () => {
    if (++inspections === 2) { checked.resolve(); await release.promise; }
    return { head: 'h1', contentFingerprint: 'c1' };
  };
  const accepting = f.call(['unit', 'accept', 'demo']);
  t.after(() => release.resolve());
  await checked.promise;
  f.adapters.gates.run = async () => pass(['AC-2']);
  assert.equal((await f.call(['evidence', 'rerun', 'demo', '--gate', 'tests'])).nondeterministic, true);
  release.resolve();
  assert.equal((await accepting).code, 1);
  const current = await f.store.read('demo');
  assert.equal(current.accepted, null);
  assert.equal(current.state, 'SelfGated');
});
