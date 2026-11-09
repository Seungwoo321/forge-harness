import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createAdapters } from './lib/adapters.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { correctionSource, currentCorrections, externalDeliveryObligations, productAcceptance, describeAcceptanceGate } from './lib/acceptance-correction.mjs';
import { gateFingerprint } from './lib/evidence.mjs';
import { validateGoalCompletion } from './lib/continuity-completion.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const parse = value => JSON.parse(value.slice(value.lastIndexOf('RESULT ') + 7));

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'criteria-drop-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, 'state'), store = createUnitStateStore(stateRoot), unit = 'unit-a';
  const target = { head: 'head-1', contentFingerprint: 'content-1' };
  await store.create({ schema: 'harness.unit/1', unit, kind: 'chore', state: 'SelfGated',
    request: { text: 'Fail fast and post failure summaries', userInputRef: 'original-request' }, canon: [],
    acceptance: [{ id: 'AC-1', text: 'Stop execution after the first failed step', status: 'open' }, { id: 'AC-2', text: 'Post a failure summary', status: 'open' }],
    policy: { goal: { class: 'task' }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] }, retry: { maxPerSignature: 2, maxResolver: 2 } },
    evidence: [], findings: [], failures: [{ signature: 'prior-failure', digest: 'preserved' }],
    stages: [{ name: 'implement', attempt: 1, submittedAt: 'earlier', checkpoint: 'checkpoint-1', checkpointHead: target.head }],
    scopePaths: ['product.mjs'], changedPaths: [], assumptions: [], openDecisions: [],
    reviewDecision: { head: target.head, contentFingerprint: target.contentFingerprint, required: true }, reviewedHead: target.head, verdict: 'ship', diff: null, handoff: null });
  const initial = await store.read(unit), authority = { operation: 'drop', unit, acceptanceRef: 'AC-2',
    criterionDigest: effectArgsDigest(initial.acceptance[1]), sourceDigest: effectArgsDigest(correctionSource(initial)), text: 'Remove failure summaries; continue fail-fast only' };
  const authorityBytes = JSON.stringify(authority), authorityPath = path.join(cwd, 'user-change.json');
  await writeFile(authorityPath, authorityBytes);
  let authorized = true, wrongBinding = false, hook = null, executions = 0;
  const core = createAdapters({ repositoryRoot: cwd });
  const adapters = { ...core, now: () => '2026-01-01T00:00:00Z', git: { inspectUnit: async () => ({ ...target }) },
    command: async (...args) => { executions += 1; return core.command(...args); },
    provider: {
      async verifyUserInput(input) { return { ...input, verified: authorized && input.userInputRef === 'user-change' && input.effect === 'unit.acceptance.drop' }; },
      async verifyAcceptanceChange(input) {
        const { request, source, target: observed, ...binding } = input;
        let verified = false;
        try {
          const bytes = await readFile(request.provenance.ref);
          verified = request.provenance.ref === authorityPath && bytes.toString() === authorityBytes && digest(bytes) === request.provenance.digest
            && request.acceptanceRef === authority.acceptanceRef && request.criterionDigest === authority.criterionDigest
            && input.operation === authority.operation && input.unit === authority.unit && input.sourceDigest === authority.sourceDigest
            && effectArgsDigest(source) === input.sourceDigest && effectArgsDigest(observed) === input.targetDigest;
        } catch { verified = false; }
        if (hook) await hook();
        return { ...binding, verified, ...(wrongBinding ? { argsDigest: 'forged' } : {}) };
      },
    },
    checkpoint: { createCheckpoint: async ({ ref }) => ({ commit: `checkpoint:${ref}`, worktreeChanged: false, indexChanged: false, excluded: [] }),
      inspectChanges: async () => ({ head: target.head, firstCheckpointDiff: [], attemptDiff: [], patch: '' }) },
  };
  const product = 'export function failFast(steps){for(const step of steps)if(!step())return false;return true}';
  const check = `import assert from 'node:assert/strict';import {failFast} from './product.mjs';const trace=[];assert.equal(failFast([()=>{trace.push(1);return false},()=>{trace.push(2);return true}]),false);assert.deepEqual(trace,[1]);console.log('TAP version 13\\n1..1\\nok 1 - AC-1 fails fast');`;
  await writeFile(path.join(cwd, 'product.mjs'), product); await writeFile(path.join(cwd, 'check.mjs'), check);
  adapters.gates = { describe: async id => ({ id, command: [process.execPath, 'check.mjs'], format: 'tap', acPattern: 'AC-[0-9]+',
    files: [{ path: 'product.mjs', content: product }, { path: 'check.mjs', content: check }] }) };
  const read = () => store.read(unit);
  const run = async args => parse(await runUnitCli(['unit', ...args], { cwd, stateRoot, adapters }));
  const request = async (overrides = {}) => { const record = await read(); return {
    id: 'drop-1', expectedRevision: record.revision, acceptanceRef: 'AC-2', criterionDigest: effectArgsDigest(record.acceptance[1]),
    sourceDigest: effectArgsDigest(correctionSource(record)), head: target.head, contentFingerprint: target.contentFingerprint,
    provenance: { ref: authorityPath, digest: digest(authorityBytes) }, reason: 'User explicitly removed failure summaries', ...overrides }; };
  const drop = async body => { const file = path.join(cwd, `${body.id}.json`); await writeFile(file, JSON.stringify(body));
    return run(['acceptance', 'drop', unit, '--request', file, '--user-input', 'user-change']); };
  return { cwd, stateRoot, store, unit, target, adapters, read, run, request, drop, authorityPath,
    deny: () => { authorized = false; }, forge: () => { wrongBinding = true; }, onVerify: value => { hook = value; }, executions: () => executions };
}

async function reviewAndAccept(f) {
  const opened = await f.run(['stage', 'open', f.unit, 'review']); assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8')), file = path.join(f.cwd, 'review.json');
  assert.equal(input.data.handoff.acceptanceAmendments.length, 1);
  assert.equal(input.data.acceptance[1].status, 'dropped');
  await writeFile(file, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'fresh-review', status: 'done',
    summary: 'Remaining product behavior and approved exclusion verified', findings: [], verdict: 'ship', reviewedHead: input.head }));
  assert.equal((await f.run(['stage', 'submit', f.unit, 'review', '--output', file])).code, 0);
  const result = await f.run(['accept', f.unit]); assert.equal(result.code, 0, JSON.stringify(result)); return result;
}

test('public drop preserves original requirements/history, invalidates evidence/review and requires fresh acceptance', async t => {
  const f = await fixture(t); assert.equal((await f.run(['accept', f.unit])).code, 1);
  const before = await f.read(), request = await f.request(), gate = await describeAcceptanceGate(f.adapters, 'impact-tests', f.unit, before), count = f.executions();
  const result = await f.drop(request); assert.equal(result.code, 0, JSON.stringify(result));
  const after = await f.read(); assert.equal(after.acceptance[1].status, 'dropped'); assert.equal(after.acceptance[1].text, before.acceptance[1].text);
  assert.deepEqual(after.acceptance[0], before.acceptance[0]);
  for (const key of ['request', 'canon', 'policy', 'stages', 'failures', 'findings']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.evidence.slice(0, before.evidence.length), before.evidence); assert.ok(after.evidence.slice(before.evidence.length).every(item => item.status === 'stale' && item.covers.length === 0));
  assert.equal(after.reviewDecision, null); assert.equal(after.reviewedHead, null); assert.equal(after.verdict, null);
  assert.deepEqual(after.acceptanceAmendments[0].beforeSource, correctionSource(before)); assert.deepEqual(after.acceptanceAmendments[0].previousReview.reviewDecision, before.reviewDecision);
  assert.equal((await f.drop(request)).amendment.duplicate, true); assert.deepEqual(await f.read(), after);
  assert.equal((await f.drop({ ...request, reason: 'different payload' })).error, 'ACCEPTANCE_DROP_CONFLICT');
  assert.notEqual(gateFingerprint(await describeAcceptanceGate(f.adapters, 'impact-tests', f.unit, after)), gateFingerprint(gate));
  assert.equal((await f.run(['accept', f.unit])).code, 20); assert.ok(f.executions() > count);
  const accepted = await reviewAndAccept(f); assert.deepEqual(accepted.coverage.covered, ['AC-1']);
  const record = await f.read(), continuity = { goal: { id: 'goal-a', status: 'active', remaining: [f.unit], criteria: before.acceptance.map(item => item.text) } };
  const unitStore = { read: async () => ({ ...record, continuity: { goalId: 'goal-a' } }) };
  await assert.rejects(validateGoalCompletion({ continuity, unit: f.unit, proof: before.acceptance.map(item => ({ criterion: item.text, unit: f.unit, acceptance: item.id })), unitStore }), { code: 'GOAL_INCOMPLETE' });
  continuity.goal.criteria = [before.acceptance[0].text];
  assert.equal(await validateGoalCompletion({ continuity, unit: f.unit, proof: [{ criterion: before.acceptance[0].text, unit: f.unit, acceptance: 'AC-1' }], unitStore }), true);
});

test('unauthorized, forged, stale, broadened and wrong-criterion changes never write', async t => {
  const f = await fixture(t), request = await f.request(), before = await f.read();
  for (const [body, error] of [
    [{ ...request, acceptance: [] }, 'ACCEPTANCE_DROP_INVALID'],
    [{ ...request, criterionDigest: [request.criterionDigest] }, 'ACCEPTANCE_DROP_INVALID'],
    [{ ...request, expectedRevision: request.expectedRevision + 1 }, 'ACCEPTANCE_DROP_STALE'],
    [{ ...request, sourceDigest: `sha256:${'0'.repeat(64)}` }, 'ACCEPTANCE_DROP_STALE'],
    [{ ...request, head: 'other-head' }, 'ACCEPTANCE_DROP_STALE'],
    [{ ...request, acceptanceRef: 'AC-1', criterionDigest: effectArgsDigest(before.acceptance[0]) }, 'ACCEPTANCE_DROP_UNPROVEN'],
    [{ ...request, provenance: { ref: f.authorityPath, digest: `sha256:${'0'.repeat(64)}` } }, 'ACCEPTANCE_DROP_UNPROVEN'],
  ]) { assert.equal((await f.drop(body)).error, error); assert.deepEqual(await f.read(), before); }
  f.forge(); assert.equal((await f.drop(request)).error, 'ACCEPTANCE_DROP_UNPROVEN'); assert.deepEqual(await f.read(), before);
  f.deny(); assert.equal((await f.drop(request)).error, 'EFFECT_APPROVAL_REQUIRED'); assert.deepEqual(await f.read(), before);
});

test('unsubmitted stages, lifecycle mismatch, missing verifier and uncertain effects fail closed', async t => {
  const f = await fixture(t);
  for (const update of [{ state: 'Accepted', accepted: { ...f.target } }, { state: 'Blocked', blockedFrom: 'SelfGated' },
    { state: 'SelfGated', accepted: null, stages: [{ name: 'implement', attempt: 2, startedAt: 'now' }] }]) {
    await f.store.update(f.unit, r => ({ ...r, ...update })); const before = await f.read();
    assert.equal((await f.drop(await f.request())).error, 'INVALID_TRANSITION'); assert.deepEqual(await f.read(), before);
  }
  await f.store.update(f.unit, r => ({ ...r, stages: [], state: 'SelfGated', accepted: null }));
  const ledger = createLedgerStore(f.stateRoot);
  await ledger.withLock(f.unit, l => l.append({ event: 'intent', seq: 1, key: 'pending', effect: 'git.push' }));
  assert.equal((await f.drop(await f.request())).error, 'EFFECT_UNCERTAIN');
  await ledger.withLock(f.unit, l => l.append({ event: 'result', seq: 1, key: 'pending', result: { status: 'completed' } }));
  delete f.adapters.provider.verifyAcceptanceChange;
  const before = await f.read(); assert.equal((await f.drop(await f.request())).error, 'ADAPTER_MISSING'); assert.deepEqual(await f.read(), before);
});

test('concurrent exclusions serialize and target drift during trusted verification is atomic', async t => {
  const f = await fixture(t), request = await f.request();
  const results = await Promise.all([f.drop(request), f.drop({ ...request, id: 'second' })]);
  assert.deepEqual(results.map(item => item.code).sort(), [0, 1]); assert.equal((await f.read()).acceptanceAmendments.length, 1);
  const other = await fixture(t), before = await other.read(); other.onVerify(() => { other.target.head = 'external'; });
  assert.equal((await other.drop(await other.request())).error, 'ACCEPTANCE_DROP_STALE'); assert.deepEqual(await other.read(), before);
});

test('acceptance racing exclusion cannot commit old review or reuse pre-exclusion gate fingerprints', async t => {
  const f = await fixture(t), describe = f.adapters.gates.describe; let dropped = false;
  f.adapters.gates.describe = async (...args) => {
    const gate = await describe(...args);
    if (!dropped) { dropped = true; assert.equal((await f.drop(await f.request())).code, 0); }
    return gate;
  };
  assert.notEqual((await f.run(['accept', f.unit])).code, 0); assert.equal((await f.read()).accepted, null);
  assert.equal((await f.run(['accept', f.unit])).code, 20); await reviewAndAccept(f);
});

test('dropping a corrected obligation preserves its audit but removes active verification; remaining corrections become stale', async t => {
  const f = await fixture(t), request = await f.request();
  const observation = { ...request, id: 'observation-1', acceptanceRef: 'AC-1', criterionDigest: effectArgsDigest((await f.read()).acceptance[0]), kind: 'observation', evidence: request.provenance };
  const delivery = { ...request, id: 'delivery-1', kind: 'delivery', owner: 'external', level: 'pr' };
  const history = [observation, delivery].map(body => ({ request: body, userInputRef: 'prior-authority', requestDigest: effectArgsDigest({ request: body, userInputRef: 'prior-authority' }) }));
  await f.store.update(f.unit, r => ({ ...r, acceptanceCorrections: history })); request.expectedRevision = (await f.read()).revision;
  assert.equal((await f.drop(request)).code, 0);
  const after = await f.read(); assert.deepEqual(after.acceptanceCorrections, history); assert.equal(currentCorrections(after).length, 1);
  assert.equal(externalDeliveryObligations(after).length, 0); assert.deepEqual(productAcceptance(after), []);
  assert.notEqual(effectArgsDigest(correctionSource(after)), request.sourceDigest);
  assert.equal((await f.run(['accept', f.unit])).error, 'ACCEPTANCE_CORRECTION_STALE');
});

test('the installed public executable loads the new trusted scope-change verifier', async t => {
  const f = await fixture(t), request = await f.request(), file = path.join(f.cwd, 'drop.json'), provider = path.join(f.cwd, 'provider.mjs');
  await writeFile(file, JSON.stringify(request));
  const expected = effectArgsDigest({ request, userInputRef: 'user-change' });
  await writeFile(provider, `export function createRuntimeAdapters(){return {git:{async inspectUnit(){return ${JSON.stringify(f.target)}}},provider:{
    async verifyUserInput(x){return {...x,verified:x.effect==='unit.acceptance.drop'&&x.argsDigest===${JSON.stringify(expected)}&&x.userInputRef==='user-change'}},
    async verifyAcceptanceChange(x){const {request,source,target,...binding}=x;return {...binding,verified:x.argsDigest===${JSON.stringify(expected)}&&x.operation==='drop'&&request.acceptanceRef==='AC-2'}}}}}`);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./unit.mjs', import.meta.url)), 'unit', 'acceptance', 'drop', f.unit,
    '--request', file, '--user-input', 'user-change', '--adapters', provider, '--state-root', f.stateRoot, '--project-root', f.cwd], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout); assert.equal((await f.read()).acceptance[1].status, 'dropped');
});

test('an older decision notification or answer cannot reactivate an explicitly excluded criterion', async t => {
  const f = await fixture(t);
  await f.store.update(f.unit, r => ({ ...r, openDecisions: [{ id: 'D-1', kind: 'preference', question: 'Keep summaries?',
    options: ['yes', 'no'], blocks: ['AC-2'], requiredAction: null, canonRefs: [], notifiedAt: null, answer: null }] }));
  assert.equal((await f.drop(await f.request())).code, 0);
  assert.equal((await f.run(['decision', 'notify', f.unit, '--decision-id', 'D-1'])).code, 0);
  assert.equal((await f.read()).acceptance[1].status, 'dropped');
  assert.equal((await f.run(['decision', 'resolve', f.unit, '--decision-id', 'D-1', '--answer', 'no'])).code, 0);
  assert.equal((await f.read()).acceptance[1].status, 'dropped');
});

for (const race of [false, true]) {
  test(`a separate pre-exclusion review cannot approve the changed scope (race=${race})`, async t => {
    const f = await fixture(t), reviewer = 'old-review';
    await f.store.update(f.unit, r => ({ ...r, state: 'InReview', head: f.target.head, contentFingerprint: f.target.contentFingerprint }));
    await f.store.create({ schema: 'harness.unit/1', unit: reviewer, kind: 'review', state: 'InReview', targetUnit: f.unit,
      policy: (await f.read()).policy, request: 'Independent review', canon: [], stages: [], acceptance: [], evidence: [], assumptions: [], openDecisions: [] });
    const opened = await f.run(['stage', 'open', reviewer, 'review']); assert.equal(opened.code, 0, JSON.stringify(opened));
    const input = JSON.parse(await readFile(opened.input, 'utf8')), file = path.join(f.cwd, 'old-ship.json');
    assert.equal(input.data.acceptance[1].status, 'open');
    await writeFile(file, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'old-ship', status: 'done',
      summary: 'Reviewed the original scope', findings: [], verdict: 'ship', reviewedHead: input.head }));
    const changeScope = async () => {
      // Model the target returning to SelfGated after failed revalidation; the separate reviewer stays open.
      await f.store.update(f.unit, r => ({ ...r, state: 'SelfGated', accepted: null }));
      assert.equal((await f.drop(await f.request())).code, 0);
      assert.equal((await f.run(['accept', f.unit])).code, 20);
    };
    if (race) {
      const inspect = f.adapters.checkpoint.inspectChanges;
      f.adapters.checkpoint.inspectChanges = async args => { await changeScope(); return inspect(args); };
    } else await changeScope();
    const submitted = await f.run(['stage', 'submit', reviewer, 'review', '--output', file]);
    assert.equal(submitted.error, 'STAGE_STALE', JSON.stringify(submitted));
    const target = await f.read(); assert.equal(target.state, 'InReview'); assert.equal(target.verdict, null); assert.equal(target.accepted, null);
    assert.equal((await f.store.read(reviewer)).state, 'InReview');
    assert.equal((await f.run(['accept', f.unit])).code, 20);
  });
}
