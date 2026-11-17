import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'policy-approval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, 'state'), store = createUnitStateStore(stateRoot), unit = 'change-a';
  const policyRequest = { id: 'external-delivery', expectedRevision: 1, delivery: 'none', reason: 'External delivery owns publication' };
  let target = { head: 'feature-head', tree: 'feature-tree', contentFingerprint: 'tree:content', repo: cwd, branch: 'feature/change-a', base: 'base' };
  const original = { ...policyRequest, unit, userInputRef: 'operator-ref',
    requestDigest: effectArgsDigest({ request: policyRequest, userInputRef: 'operator-ref' }),
    before: 'merge', after: 'none', previousPolicy: { goal: { class: 'task' }, delivery: 'merge' },
    previousAcceptance: { ...target, validatedHead: target.head }, revision: 2, changedAt: '2026-01-01T00:00:00Z' };
  await store.create({ schema: 'harness.unit/1', unit, revision: 0, kind: 'code', state: 'Scoped',
    request: { text: 'Deliver the original change', userInputRef: 'human-ref' }, stages: [],
    policy: { goal: { class: 'task' }, delivery: 'merge' }, policyOverrides: { delivery: 'none' },
    evidence: [{ gate: 'tests', status: 'stale' }], failures: [{ signature: 'prior-failure' }],
    findings: [{ id: 'prior-finding' }], policyChanges: [original] });
  await store.update(unit, r => ({ ...r, state: 'SelfGated', accepted: null, verdict: null, reviewedHead: null, reviewDecision: null }));
  let authorized = true, drift = false, wrongBinding = false;
  const adapters = { now: () => '2026-01-02T00:00:00Z', git: { async inspectUnit() { return structuredClone(target); } },
    provider: { async verifyUserInput(input) {
      if (drift) target = { ...target, head: 'changed-during-verification' };
      return { ...input, ...(wrongBinding ? { targetDigest: 'different' } : {}), verified: authorized
        && input.effect === 'unit.policy.approval.correct' && input.userInputRef === 'human-ref'
        && input.previousUserInputRef === 'operator-ref' && input.policyChangeDigest === effectArgsDigest(original) };
    } } };
  const read = () => store.read(unit);
  const request = async (extra = {}) => ({ id: 'source-1', expectedRevision: (await read()).revision,
    change: { index: 0, digest: effectArgsDigest(original) }, reason: 'Reattest the identical policy from original human authority', ...extra });
  let sequence = 0;
  const run = async (body, ref = 'human-ref') => {
    const file = path.join(cwd, `request-${body.id}-${sequence++}.json`); await writeFile(file, JSON.stringify(body));
    const output = await runUnitCli(['unit', 'policy', 'approval-correct', unit, '--request', file, '--user-input', ref], { cwd, stateRoot, adapters });
    return JSON.parse(output.split('\n').at(-1).slice(7));
  };
  return { cwd, stateRoot, store, unit, original, target, read, request, run,
    deny: () => { authorized = false; }, drift: () => { drift = true; }, wrongBinding: () => { wrongBinding = true; } };
}

test('H-GC-02 public approval correction appends exact human authority without changing policy, acceptance or failed evidence', async t => {
  const f = await fixture(t), before = await f.read(), request = await f.request();
  const result = await f.run(request); assert.equal(result.code, 0, JSON.stringify(result));
  const after = await f.read(), { policyApprovalCorrections, revision, ...rest } = after;
  const { revision: previousRevision, ...previous } = before;
  assert.deepEqual(rest, previous);
  assert.equal(revision, previousRevision + 1); assert.equal(policyApprovalCorrections.length, 1);
  assert.deepEqual(policyApprovalCorrections[0].original, f.original);
  assert.deepEqual(policyApprovalCorrections[0].target, f.target);
  assert.equal(policyApprovalCorrections[0].targetDigest, effectArgsDigest(f.target));
  assert.equal(policyApprovalCorrections[0].userInputRef, 'human-ref');
  assert.equal(after.state, 'SelfGated'); assert.equal(after.accepted, null); assert.equal(after.verdict, null);
  assert.equal((await f.run(request)).receipt.duplicate, true); assert.deepEqual(await f.read(), after);
  assert.equal((await f.run({ ...request, reason: 'changed request' })).error, 'POLICY_APPROVAL_CORRECTION_INVALID');
  assert.deepEqual(await f.read(), after);
});

test('wrong authority, binding, original change and current revision never append a correction', async t => {
  for (const mode of ['deny', 'binding', 'same-ref', 'index', 'digest', 'extra', 'revision']) {
    const f = await fixture(t), before = await f.read(); let body = await f.request(), ref = 'human-ref';
    if (mode === 'deny') f.deny();
    if (mode === 'binding') f.wrongBinding();
    if (mode === 'same-ref') ref = 'operator-ref';
    if (mode === 'index') body.change.index = 1;
    if (mode === 'digest') body.change.digest = 'sha256:' + '0'.repeat(64);
    if (mode === 'extra') body.delivery = 'merge';
    if (mode === 'revision') body.expectedRevision += 1;
    assert.notEqual((await f.run(body, ref)).code, 0, mode); assert.deepEqual(await f.read(), before, mode);
  }
});

test('delivered, accepted, stopped, active-stage and superseded policy changes cannot be reattested', async t => {
  for (const mode of ['Accepted', 'Delivered', 'Stopped', 'active-stage', 'superseded', 'effective', 'malformed-original']) {
    const f = await fixture(t);
    await f.store.update(f.unit, r => mode === 'active-stage'
      ? { ...r, stages: [{ name: 'implement', attempts: [{ attempt: 1, startedAt: '2026-01-01' }] }] }
      : mode === 'superseded' ? { ...r, policyChanges: [...r.policyChanges, { ...f.original, id: 'later' }] }
      : mode === 'effective' ? { ...r, policyOverrides: { delivery: 'merge' } }
      : mode === 'malformed-original' ? { ...r, policyChanges: [{ ...f.original, unit: 'another-unit' }] }
      : { ...r, state: mode });
    const before = await f.read(); assert.notEqual((await f.run(await f.request())).code, 0, mode);
    assert.deepEqual(await f.read(), before, mode);
  }
});

test('target drift and unresolved or newly uncertain effects preserve the original audit', async t => {
  for (const mode of ['target', 'pending', 'uncertain-after-completed']) {
    const f = await fixture(t);
    if (mode === 'target') f.drift();
    else await createLedgerStore(f.stateRoot).withLock(f.unit, async ledger => {
      await ledger.append({ event: 'intent', seq: 1, effect: 'git.push', key: 'pending' });
      if (mode === 'uncertain-after-completed') {
        await ledger.append({ event: 'result', seq: 1, key: 'pending', result: { status: 'completed' } });
        await ledger.append({ event: 'result', seq: 1, key: 'pending', result: { status: 'uncertain' } });
      }
    });
    const before = await f.read(); assert.notEqual((await f.run(await f.request())).code, 0, mode);
    assert.deepEqual(await f.read(), before, mode);
  }
});

test('concurrent identical correction requests append once and retain an existing reviewed target', async t => {
  const f = await fixture(t);
  await f.store.update(f.unit, r => ({ ...r, state: 'InReview', verdict: 'ship', reviewedHead: 'feature-head', reviewDecision: { head: 'feature-head' } }));
  const before = await f.read(), body = await f.request();
  const results = await Promise.all([f.run(body), f.run(body)]);
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  const after = await f.read(); assert.equal(after.policyApprovalCorrections.length, 1);
  assert.equal(after.revision, before.revision + 1); assert.equal(after.reviewedHead, before.reviewedHead);
  assert.deepEqual(after.reviewDecision, before.reviewDecision); assert.deepEqual(after.evidence, before.evidence);
});

test('public executable requires and loads the correction authority provider', async t => {
  const f = await fixture(t), request = await f.request(), body = path.join(f.cwd, 'public.json'), provider = path.join(f.cwd, 'provider.mjs');
  await writeFile(body, JSON.stringify(request));
  await writeFile(provider, `export function createRuntimeAdapters(){return {git:{async inspectUnit(){return ${JSON.stringify(f.target)}}},provider:{async verifyUserInput(i){return {...i,verified:i.userInputRef==='human-ref'&&i.effect==='unit.policy.approval.correct'}}}}}`);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./unit.mjs', import.meta.url)), 'unit', 'policy', 'approval-correct', f.unit,
    '--request', body, '--user-input', 'human-ref', '--adapters', provider, '--state-root', f.stateRoot, '--project-root', f.cwd], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout); assert.match(child.stdout, /Policy approval corrected/);
  assert.equal((await f.read()).policyApprovalCorrections[0].userInputRef, 'human-ref');
});
