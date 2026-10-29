import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { acceptanceCoverage, gateFingerprint } from './lib/evidence.mjs';
import { executeDelivery } from './lib/delivery-flow.mjs';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const ordinaryArgs = { database: 'local-db', migrationDigest: 'migration-1' };
const deleteArgs = { resource: 'drafts', selectionDigest: 'selection-1' };
const gate = { id: 'tests', command: ['check', 'tests'], files: [{ path: 'src/main.mjs', content: 'source' }], format: 'exec' };

async function fixture(t, { state = 'Implementing' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'public-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product checkout');
  await mkdir(cwd);
  const stateRoot = path.join(root, 'state');
  const store = createUnitStateStore(stateRoot);
  await store.create({ schema: 'harness.unit/1', unit: 'unit-a', revision: 0, kind: 'impl', state,
    policy: { goal: { class: 'product-prelaunch' }, delivery: 'none', review: { mode: 'none', by: 'session', triggers: [] } },
    accepted: ['Accepted', 'Delivering', 'Delivered', 'Blocked', 'Stopped'].includes(state) ? { head: 'head-1', contentFingerprint: 'content-1' } : null,
    ...(state === 'Blocked' ? { blockedFrom: 'Delivering' } : state === 'Stopped' ? { stoppedFrom: 'Delivered' } : {}),
    acceptance: [{ id: 'AC-1', status: 'open' }], evidence: [], stages: [], openDecisions: [],
  });
  const native = path.join(root, 'native.json');
  const trace = path.join(root, 'trace.ndjson');
  const ledgerPath = path.join(stateRoot, 'units', 'unit-a', 'ledger.ndjson');
  await writeFile(native, JSON.stringify({ mode: 'pass', head: 'head-1', contentFingerprint: 'content-1', runs: 0 }));
  const stub = path.join(root, 'integration.mjs');
  await writeFile(stub, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [operation, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const state = JSON.parse(readFileSync(process.env.TEST_NATIVE));
const output = value => process.stdout.write(JSON.stringify(value));
appendFileSync(process.env.TEST_TRACE, JSON.stringify({ operation, input })+'\\n');
if (operation === 'inspect') output({ head: state.head, contentFingerprint: state.contentFingerprint });
else if (operation === 'context') {
  const context = { resourceOwned: true, productOwned: true, inScope: true, operational: false,
    irreversible: state.mode === 'elevated', containsSecret: false, forbiddenCommand: false };
  if (state.mode === 'missing-context') delete context.resourceOwned;
  if (state.mode === 'unowned') context.resourceOwned = false;
  output(context);
} else if (operation === 'user-input') {
  if (state.mode === 'changed-during-verification') { state.head = 'head-2'; writeFileSync(process.env.TEST_NATIVE, JSON.stringify(state)); }
  output({ ...input, verified: input.userInputRef === 'user-message-1' && state.mode !== 'unverified',
    ...(state.mode === 'wrong-tuple' ? { head: 'head-other' } : {}) });
} else if (operation === 'execute') {
  const rows = readFileSync(process.env.TEST_LEDGER, 'utf8').trim().split('\\n').map(JSON.parse);
  if (rows.at(-1).event !== 'intent' || rows.at(-1).key !== input.key) process.exit(9);
  state.applied = true; writeFileSync(process.env.TEST_NATIVE, JSON.stringify(state));
  if (state.mode === 'uncertain') process.exit(8);
  output({ applied: true, verify: 'external-observation' });
} else if (operation === 'verify') output({ status: state.applied ? 'completed' : 'unknown', result: { applied: true }, verify: 'independent-inspection' });
else if (operation === 'describe') output({ ...${JSON.stringify(gate)}, id: input.id,
  files: [{ path: 'src/main.mjs', content: state.mode === 'changed-input' ? 'changed' : state.source ?? 'source' }] });
else if (operation === 'gate') {
  state.runs += 1; writeFileSync(process.env.TEST_NATIVE, JSON.stringify(state));
  if (state.mode === 'input-drift') { state.source = 'changed'; writeFileSync(process.env.TEST_NATIVE, JSON.stringify(state)); }
  const failureClass = ['product','environment','harness','user-domain','unknown'].includes(state.mode) ? state.mode : null;
  output({ exit: failureClass ? 1 : 0, ok: !failureClass, failureClass,
    covers: [state.mode === 'divergent' ? 'AC-2' : 'AC-1'],
    report: state.mode === 'missing-report' ? undefined : '{}', reportPath: 'reports/'+input.id+'.json' });
}
`);
  await chmod(stub, 0o755);
  const providers = path.join(root, 'adapters.mjs');
  await writeFile(providers, `
export async function createRuntimeAdapters({ adapters, cwd }) {
  const call = async (operation, input) => {
    const result = await adapters.command(${JSON.stringify(stub)}, [operation, JSON.stringify(input)], { cwd });
    if (result.exitCode !== 0) throw Error('integration failed');
    return JSON.parse(result.stdout);
  };
  return { effect: { execute: x => call('execute', x), verify: x => call('verify', x) },
    effectContext: x => call('context', x), provider: { verifyUserInput: x => call('user-input', x) },
    git: { inspectUnit: x => call('inspect', x) },
    gates: { describe: id => call('describe', { id }), run: x => call('gate', x) } };
}
`);
  const run = args => {
    const child = spawnSync(process.execPath, [cli, ...args, '--adapters', providers, '--state-root', stateRoot, '--project-root', cwd], {
      cwd, encoding: 'utf8', env: { ...process.env, TEST_NATIVE: native, TEST_TRACE: trace, TEST_LEDGER: ledgerPath },
    });
    const line = child.stdout.trim().split('\n').at(-1);
    assert.match(line ?? '', /^RESULT /, child.stderr);
    const result = JSON.parse(line.slice(7));
    assert.equal(child.status, result.code);
    return result;
  };
  const setNative = async patch => writeFile(native, JSON.stringify({ ...JSON.parse(await readFile(native, 'utf8')), ...patch }));
  const effect = async (effect = 'db.local.change', args = ordinaryArgs, approval) => {
    await writeFile(path.join(cwd, 'args.json'), JSON.stringify(args));
    return run(['unit', 'effect', 'unit-a', '--effect', effect, '--args', 'args.json', ...(approval ? ['--approval', approval] : [])]);
  };
  const approve = async (userInputRef = 'user-message-1') => {
    await writeFile(path.join(cwd, 'approval.json'), JSON.stringify({ effect: 'data.delete', args: deleteArgs, reason: 'remove owned drafts' }));
    return run(['unit', 'approval', 'record', 'unit-a', '--request', 'approval.json', '--user-input', userInputRef]);
  };
  const seedEvidence = async () => store.update('unit-a', current => ({ ...current, evidence: [{ gate: 'tests', fingerprint: gateFingerprint(gate),
    command: gate.command, exit: 0, failureClass: null, status: 'passed', covers: ['AC-1'], report: 'reports/original.json', digest: 'sha256:original' }] }));
  const rows = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { cwd, stateRoot, store, native, providers, run, effect, approve, setNative, seedEvidence, rows,
    rerun: () => run(['evidence', 'rerun', 'unit-a', '--gate', 'tests']),
    ledger: () => createLedgerStore(stateRoot).withLock('unit-a', entries => entries.read()) };
}

test('PUBLIC-EFFECT-REGISTERED-LEDGERED: public E2 execution records intent before the provider and persists result', async t => {
  const f = await fixture(t);
  assert.equal((await f.effect()).code, 0);
  assert.equal((await f.effect()).status, 'duplicate');
  assert.deepEqual((await f.ledger()).map(row => row.event), ['intent', 'result']);
  assert.equal((await f.rows()).filter(row => row.operation === 'execute').length, 1);
  const uncertain = await fixture(t);
  await uncertain.setNative({ mode: 'uncertain' });
  assert.equal((await uncertain.effect()).code, 3);
  assert.equal((await uncertain.effect()).status, 'reconciled');
  assert.deepEqual((await uncertain.ledger()).map(row => row.event), ['intent', 'result']);
  assert.equal((await uncertain.rows()).filter(row => row.operation === 'execute').length, 1);
});

test('PUBLIC-E4-APPROVAL-BOUND: public approval and effect bind the exact trusted tuple at the accepted head', async t => {
  const f = await fixture(t, { state: 'Accepted' });
  const result = await f.approve();
  assert.equal(result.code, 0);
  const approval = result.approval;
  assert.deepEqual(Object.keys(approval).sort(), ['approvedAt', 'argsDigest', 'effect', 'head', 'id', 'reason', 'userInputRef']);
  assert.equal(approval.argsDigest, effectArgsDigest(deleteArgs));
  assert.equal(approval.effect, 'data.delete');
  assert.equal(approval.head, 'head-1');
  assert.equal(approval.reason, 'remove owned drafts');
  assert.equal(approval.userInputRef, 'user-message-1');
  assert.ok(approval.id && Number.isFinite(Date.parse(approval.approvedAt)));
  assert.equal((await f.effect('data.delete', deleteArgs, approval.id)).code, 0);
  const ledger = await f.ledger();
  assert.deepEqual(ledger.map(row => row.event), ['intent', 'result']);
  assert.equal(ledger[0].class, 'E4');
  assert.equal(ledger[0].approvalRef, approval.id);
  assert.equal((await f.rows()).filter(row => row.operation === 'user-input').length, 2);
});

test('PUBLIC-E4-INVALID-APPROVAL: public E4 preflight refuses absent, unverified, self-asserted and mismatched approvals', async t => {
  for (const mode of ['absent', 'fabricated', 'unverified', 'wrong-tuple', 'changed-args', 'changed-head', 'stale-head', 'changed-during-verification', 'missing-date', 'self-asserted']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { state: 'Accepted' });
      let approval;
      if (!['absent', 'fabricated', 'self-asserted'].includes(mode)) approval = (await f.approve()).approval;
      if (['unverified', 'wrong-tuple', 'changed-during-verification'].includes(mode)) await f.setNative({ mode });
      if (mode === 'changed-head') await f.setNative({ head: 'head-2' });
      if (mode === 'stale-head') await f.store.update('unit-a', record => ({ ...record, accepted: { ...record.accepted, head: 'head-2' } }));
      if (mode === 'missing-date') await f.store.update('unit-a', record => ({ ...record, approvals: record.approvals.map(item => ({ ...item, approvedAt: null })) }));
      const result = await f.effect('data.delete', mode === 'changed-args' ? { ...deleteArgs, extra: 'changed' } : deleteArgs,
        approval?.id ?? (mode === 'fabricated' ? 'invented' : undefined));
      assert.equal(result.code, 3, JSON.stringify(result));
      assert.equal((await f.rows()).some(row => row.operation === 'execute'), false);
      assert.deepEqual(await f.ledger(), []);
    });
  }
  for (const mode of ['unverified', 'wrong-tuple', 'self-asserted']) {
    const f = await fixture(t, { state: 'Accepted' });
    await f.setNative({ mode });
    assert.equal((await f.approve(mode === 'self-asserted' ? 'skill-output:verified' : 'user-message-1')).code, 3);
    assert.equal((await f.store.read('unit-a')).approvals, undefined);
  }
});

test('PUBLIC-EVIDENCE-RERUN-CLI: public rerun independently executes matching inputs and persists its comparison', async t => {
  const f = await fixture(t, { state: 'Accepted' });
  await f.seedEvidence();
  for (let i = 0; i < 2; i += 1) {
    const result = f.rerun();
    assert.equal(result.code, 0);
    assert.equal(result.reused, false);
    assert.equal(result.record.comparison.comparable, true);
    assert.equal(result.record.nondeterministic, undefined);
  }
  assert.equal(JSON.parse(await readFile(f.native, 'utf8')).runs, 2);
  assert.equal((await f.store.read('unit-a')).evidence.at(-1).status, 'passed');
  await f.setNative({ mode: 'changed-input' });
  assert.equal(f.rerun().error, 'EVIDENCE_STALE');
  assert.equal(JSON.parse(await readFile(f.native, 'utf8')).runs, 2);
  const empty = await fixture(t);
  assert.equal(empty.rerun().error, 'EVIDENCE_STALE');
});

test('PUBLIC-EVIDENCE-RERUN-NONDETERMINISM: divergence excludes coverage and cannot be erased by acceptance', async t => {
  const f = await fixture(t, { state: 'Accepted' });
  await f.seedEvidence();
  await f.store.update('unit-a', record => ({ ...record, evidence: [{ ...record.evidence[0], fingerprint: 'sha256:old' }, ...record.evidence] }));
  await f.setNative({ mode: 'divergent' });
  const result = f.rerun();
  assert.equal(result.nondeterministic, true);
  let record = await f.store.read('unit-a');
  assert.equal(record.state, 'SelfGated');
  assert.equal(record.accepted, null);
  assert.equal(acceptanceCoverage(record.acceptance, record.evidence).ok, false);
  await f.setNative({ mode: 'pass' });
  assert.equal(f.run(['unit', 'accept', 'unit-a']).code, 1);
  record = await f.store.read('unit-a');
  assert.equal(record.evidence.find(item => item.gate === 'tests').nondeterministic, true);
  assert.equal(record.accepted, null);
});

test('PUBLIC-EVIDENCE-RERUN-NONDETERMINISM: only valid product or successful results participate', async t => {
  for (const mode of ['environment', 'harness', 'user-domain', 'unknown', 'missing-report', 'input-drift', 'product']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { state: 'Accepted' });
      await f.seedEvidence();
      await f.setNative({ mode });
      const result = f.rerun();
      assert.equal(result.record.comparison.comparable, mode === 'product');
      assert.equal(result.nondeterministic, mode === 'product');
      assert.equal((await f.store.read('unit-a')).accepted, null);
    });
  }
});

test('PUBLIC-EVIDENCE-RERUN-NONDETERMINISM: excluded failures and input round trips retain comparison knowledge', async t => {
  for (const mode of ['environment', 'harness', 'user-domain', 'unknown', 'missing-report']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { state: 'Accepted' });
      await f.seedEvidence();
      await f.setNative({ mode });
      assert.equal(f.rerun().nondeterministic, false);
      await f.setNative({ mode: 'divergent' });
      assert.equal(f.rerun().nondeterministic, true);
      assert.equal(acceptanceCoverage((await f.store.read('unit-a')).acceptance, (await f.store.read('unit-a')).evidence).ok, false);
      await f.setNative({ mode: 'pass', source: 'other source' });
      assert.equal(f.run(['unit', 'accept', 'unit-a']).code, 0);
      await f.setNative({ source: 'source' });
      assert.equal(f.run(['unit', 'accept', 'unit-a']).code, 1);
      const record = await f.store.read('unit-a');
      assert.equal(record.evidence.find(item => item.gate === 'tests').nondeterministic, true);
      assert.equal(record.accepted, null);
    });
  }
});

test('PUBLIC-E4-INVALID-APPROVAL: failed reruns atomically revoke all resumable acceptance and refuse effects and finish', async t => {
  for (const state of ['Accepted', 'Delivering', 'Delivered', 'Blocked', 'Stopped']) {
    for (const mode of ['divergent', 'environment']) {
      await t.test(`${state}/${mode}`, async t => {
        const f = await fixture(t, { state });
        await f.seedEvidence();
        await f.store.update('unit-a', record => ({ ...record, reviewedHead: 'head-1', verdict: 'ship', reviewDecision: { by: 'session' },
          deliveryResult: { level: 'none' }, terminalProjection: { projected: true },
          approvals: [{ id: 'allow', effect: 'data.delete', argsDigest: effectArgsDigest(deleteArgs), head: 'head-1',
            reason: 'remove owned drafts', userInputRef: 'user-message-1', approvedAt: '2026-10-29T00:00:00Z' }] }));
        await f.setNative({ mode });
        assert.notEqual(f.rerun().code, 0);
        const record = await f.store.read('unit-a');
        assert.equal(record.state, ['Blocked', 'Stopped'].includes(state) ? state : 'SelfGated');
        if (state === 'Blocked') assert.equal(record.blockedFrom, 'SelfGated');
        if (state === 'Stopped') assert.equal(record.stoppedFrom, 'SelfGated');
        for (const field of ['accepted', 'reviewDecision', 'reviewedHead', 'verdict', 'deliveryResult', 'terminalProjection']) assert.equal(record[field], null);
        assert.notEqual((await f.effect('data.delete', deleteArgs, 'allow')).code, 0);
        assert.equal((await f.rows()).some(row => row.operation === 'execute'), false);
        assert.deepEqual(await f.ledger(), []);
        await writeFile(path.join(f.cwd, 'finish.json'), JSON.stringify({ goalComplete: true }));
        assert.notEqual(f.run(['unit', 'finish', 'unit-a', '--request', 'finish.json']).code, 0);
        if (mode === 'environment' && state === 'Delivering') {
          await f.setNative({ mode: 'pass' });
          assert.equal(f.run(['unit', 'accept', 'unit-a']).code, 0);
          assert.equal((await f.approve()).code, 0);
        }
      });
    }
  }
});

test('PUBLIC-E4-INVALID-APPROVAL: effect and delivery boundaries reject persisted invalid evidence despite a matching accepted target', async t => {
  for (const state of ['Accepted', 'Delivering', 'Delivered']) {
    for (const level of ['none', 'push', 'merge']) {
      await t.test(`${state}/${level}`, async t => {
        const f = await fixture(t, { state });
        await f.seedEvidence();
        await f.store.update('unit-a', record => ({ ...record, policy: { ...record.policy, delivery: level },
          evidence: record.evidence.map(item => ({ ...item, status: 'failed', exit: 1, failureClass: 'environment' })) }));
        if (state !== 'Delivered') {
          assert.notEqual((await f.effect('data.delete', deleteArgs, 'allow')).code, 0);
          assert.deepEqual(await f.ledger(), []);
        }
        let executions = 0;
        const result = await executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: 'unit-a', requestedDelivery: level,
          adapters: { git: { inspectUnit: async () => ({ head: 'head-1', contentFingerprint: 'content-1' }), execute: async () => { executions++; } } } });
        assert.equal(result.code, 1);
        assert.equal(result.state, 'SelfGated');
        assert.equal(executions, 0);
        assert.deepEqual(await f.ledger(), []);
      });
    }
  }
});

test('public effect validates registration, arguments, trusted context, ownership and effective E4 elevation', async t => {
  for (const registration of [{ effect: {} }, { effectContext: true }, { effect: {}, effectContext: true }, { clock: {} }]) {
    const f = await fixture(t);
    await writeFile(f.providers, `export function createRuntimeAdapters(){ return ${JSON.stringify(registration)}; }`);
    assert.equal((await f.effect()).code, 4);
    assert.deepEqual(await f.ledger(), []);
  }
  for (const mode of ['missing-context', 'unowned', 'elevated']) {
    const f = await fixture(t);
    await f.setNative({ mode });
    assert.notEqual((await f.effect()).code, 0);
    assert.equal((await f.rows()).some(row => row.operation === 'execute'), false);
    assert.deepEqual(await f.ledger(), []);
  }
  const f = await fixture(t);
  assert.notEqual((await f.effect('db.local.change', { database: 'local-db' })).code, 0);
  assert.equal((await f.rows()).some(row => row.operation === 'context' || row.operation === 'execute'), false);
  assert.equal(f.run(['unit', 'effect', 'unit-a', '--effect', 'db.local.change', '--args', 'args.json', '--class', 'E0']).code, 2);
});
