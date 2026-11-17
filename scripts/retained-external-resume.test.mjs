import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { effectArgsDigest } from './lib/approvals.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'original.txt'), digest: hash('Original human instruction to complete the work') };
  await writeFile(source.path, 'Original human instruction to complete the work');
  const resolution = { ref: path.join(root, 'resolved.json'), digest: hash('{"predecessorMerged":true}') };
  await writeFile(resolution.ref, '{"predecessorMerged":true}');
  const store = createUnitStateStore(root), goals = createContinuityStore(root);
  const execution = { runtime: 'cmux', provider: 'codex', account: '/fixture-account', model: 'model', effort: 'low', argv: ['codex'] };
  await goals.create({ goal: { id: 'g', objective: 'Finish original work', criteria: ['Original full obligation'], remaining: ['u'], status: 'active' }, source, policy: execution });
  const owner = { unit: 'u', sessionId: 'original-owner', incarnationId: 'inc', cwd: root, nativeThreadId: 'thread' };
  await goals.transaction('g', g => ({ ...g, revision: g.revision + 1, bootstraps: [owner] }));
  const target = { head: 'head', contentFingerprint: 'content' };
  const evidence = ['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage'].map(gate => ({ gate, status: 'passed', exit: 0, covers: ['AC-1'], failureClass: null, fingerprint: hash(gate) }));
  await store.create({ schema: 'harness.unit/1', unit: 'u', kind: 'impl', state: 'Accepted', continuity: { goalId: 'g' },
    request: { text: 'Original work', userInputRef: 'original-human' }, canon: [], scopePaths: ['src/'], feedback: [], assumptions: [],
    policy: { goal: { class: 'task' }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] }, retry: { maxPerSignature: 2 } },
    acceptance: [{ id: 'AC-1', text: 'Original full obligation' }], evidence, accepted: { ...target, basis: 'review' }, ...target,
    reviewedHead: 'head', verdict: 'ship', reviewDecision: { required: true, contentFingerprint: 'content' }, stages: [{ name: 'implement', attempts: [{ n: 1, endedAt: 'done' }] }] });
  let effects = 0, serial = 0;
  const native = { ...owner, runtime: 'cmux', executable: '/bin/codex', closable: true, worker: { executable: '/bin/codex', pid: 12345, threadId: 'thread', incarnationId: 'worker-inc' } };
  const adapters = { id: () => 'external-wait', now: () => '2026-01-01T00:00:00Z', git: { inspectUnit: async () => target },
    checkpoint: { createCheckpoint: async ({ ref }) => ({ commit: ref, head: target.head, excluded: [], worktreeChanged: false, indexChanged: false }),
      inspectChanges: async () => ({ firstCheckpointDiff: ['src/main.js'], attemptDiff: ['src/main.js'] }) },
    session: { observe: async () => native, execute: async () => { effects++; throw new Error('no session effects allowed'); } },
    provider: { verifyUserInput: async input => ({ ...input, verified: input.userInputRef === 'original-human' }),
      verifyRetainedExternalResume: async input => ({ ...input, verified: true,
        externalResolved: JSON.parse(await readFile(input.request.resolutionEvidence.ref, 'utf8')).predecessorMerged === true }) } };
  const cli = async (args, request, kind = '--request') => {
    if (request) { const file = path.join(root, `request-${++serial}.json`); await writeFile(file, JSON.stringify(request)); args = [...args, kind, file]; }
    const output = await runUnitCli(args, { cwd: root, stateRoot: root, adapters });
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  };
  const failure = await cli(['unit', 'fail', 'u'], { class: 'user-domain', failurePoint: 'delivery/predecessor', reason: 'Wait for predecessor PR merge' }, '--failure');
  assert.equal(failure.code, 3, JSON.stringify(failure));
  assert.equal((await cli(['goal', 'block', 'g'], { expectedRevision: (await goals.read('g')).revision, unit: 'u', reason: 'External predecessor PR wait', resumeCondition: 'Actual predecessor merged', evidence: failure.failureRef.path })).code, 0);
  const packet = ['목표: original', '수용 기준: full obligation', '작업관리: original unit', '결정: preserve', '변경: accepted content', '검증: original tests', '남은 일·위험: external wait', '다음 단위 첫 행동: same-owner continuation'].join('\n');
  const resultFields = { title: 'External wait', objective: 'Original work', acceptance: 'Original full obligation', tracking: 'Original unit', decision: 'Wait for predecessor', changed: 'Original accepted content', verification: 'Original tests', remainingRisk: 'External predecessor', nextFirstAction: 'Continue original owner' };
  const parentRuntime = { runtime: native.runtime, sessionId: native.sessionId, incarnationId: native.incarnationId, cwd: root, workerExecutable: native.executable };
  assert.equal((await cli(['unit', 'session-stop', 'u'], { parentRuntime, handoffContent: packet, resultFields, classification: 'external-input' })).code, 0);
  const record = await store.read('u'), goal = await goals.read('g');
  const rows = await createLedgerStore(root).withLock('u', ledger => ledger.read());
  const request = { id: 'external-resolution-1', expectedRevision: goal.revision, unit: 'u', unitDigest: effectArgsDigest(record), goalDigest: effectArgsDigest(goal), ledgerDigest: effectArgsDigest(rows),
    targetDigest: effectArgsDigest(target), custodyDigest: effectArgsDigest(owner), externalResolution: { ref: source.path, digest: source.digest }, resolutionEvidence: resolution, reason: 'Actual external predecessor merged; continue original owner' };
  const snapshot = { git: { head: target.head, checkpoints: {}, worktreeDiff: [], indexDiff: [] }, currentFingerprints: Object.fromEntries(evidence.map(item => [item.gate, item.fingerprint])) };
  const activate = (input = request, user = 'original-human') => cli(['goal', 'resume', 'g', '--user-input', user], input);
  const refresh = async () => Object.assign(request, { unitDigest: effectArgsDigest(await store.read('u')), goalDigest: effectArgsDigest(await goals.read('g')),
    expectedRevision: (await goals.read('g')).revision, ledgerDigest: effectArgsDigest(await createLedgerStore(root).withLock('u', ledger => ledger.read())) });
  return { root, source, resolution, store, goals, record, goal, target, adapters, cli, request, snapshot, activate, refresh, effects: () => effects };
}

test('public external stop -> same goal/unit resume preserves custody/history and requires fresh gates/review', async t => {
  const f = await fixture(t), failure = await readFile(path.join(f.root, f.goal.goal.blocker.evidence));
  assert.equal((await f.activate()).code, 0);
  assert.equal((await f.activate()).code, 0, 'same goal commit replay');
  assert.deepEqual(await f.store.read('u'), f.record, 'goal resume leaves Accepted stop untouched');
  const goal = await f.goals.read('g');
  assert.equal(goal.retainedExternalResumptions.length, 1); assert.deepEqual(goal.bootstraps, f.goal.bootstraps);
  const snapshotPath = path.join(f.root, 'snapshot.json'); await writeFile(snapshotPath, JSON.stringify(f.snapshot));
  const result = await f.cli(['unit', 'resume', 'u', '--snapshot', snapshotPath]);
  assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.state, 'Implementing'); assert.equal(result.stage, 'implement');
  assert.equal(result.recovery.nextStage, 'implement');
  const record = await f.store.read('u');
  assert.equal(record.state, 'Implementing');
  assert.equal(record.accepted, null); assert.equal(record.reviewDecision, null);
  assert.deepEqual(record.resumeRevalidations.at(-1).previousAcceptance, f.record.accepted);
  assert.deepEqual(record.resumeRevalidations.at(-1).previousReview.reviewDecision, f.record.reviewDecision);
  for (const key of ['failures', 'stopReport', 'acceptance', 'policy', 'request', 'canon']) assert.deepEqual(record[key], f.record[key], key);
  assert.equal(record.sessionHistory.at(-1).mode, 'retained-external');
  assert.ok(record.evidence.slice(f.record.evidence.length).every(e => e.status === 'stale' && e.covers.length === 0));
  assert.deepEqual(await readFile(path.join(f.root, f.goal.goal.blocker.evidence)), failure); assert.equal(f.effects(), 0);
  assert.equal((await f.cli(['unit', 'finish', 'u'], {})).code !== 0, true, 'cannot deliver preserved old acceptance');
  const opened = await f.cli(['unit', 'stage', 'open', 'u', 'implement']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  assert.equal(input.attempt, 2); assert.deepEqual(input.data.acceptance, f.record.acceptance);
  const output = { inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'integrate-resolved-dependency', status: 'done', summary: 'Integrate resolved dependency',
    changedPaths: ['src/main.js'], coverage: [{ acceptanceRef: 'AC-1', evidenceHint: 'Current product tests' }], assumptions: [], openDecisions: [] };
  const file = path.join(f.root, 'implement-output.json'); await writeFile(file, JSON.stringify(output));
  const submitted = await f.cli(['unit', 'stage', 'submit', 'u', 'implement', '--output', file]);
  assert.equal(submitted.code, 0, JSON.stringify(submitted)); assert.equal((await f.store.read('u')).state, 'SelfGated');
  assert.equal((await f.store.read('u')).accepted, null, 'ordinary implementation submission does not restore historical acceptance');
});

test('external continuation refuses stale, untrusted, changed, conflicting and unresolved states without mutation', async t => {
  const cases = {
    'relay is not authority': f => { f.activate = () => f.cli(['goal', 'resume', 'g', '--user-input', 'operational-relay'], f.request); },
    'missing provider': f => { delete f.adapters.provider.verifyRetainedExternalResume; },
    'resolution not proven': f => { f.adapters.provider.verifyRetainedExternalResume = async input => ({ ...input, verified: true, externalResolved: false }); },
    'binding-only proof insufficient': f => { f.adapters.provider.verifyRetainedExternalResume = async input => ({ ...input, verified: true, bindingOnly: true }); },
    'proof for other target': f => { f.adapters.provider.verifyRetainedExternalResume = async input => ({ ...input, verified: true, externalResolved: true, targetDigest: hash('other') }); },
    'native owner changed': f => { f.adapters.session.observe = async () => ({ sessionId: 'other', incarnationId: 'inc', cwd: f.root }); },
    'native owner absent': f => { f.adapters.session.observe = async () => { throw new Error('owner absent'); }; },
    'target changed': f => { f.target.contentFingerprint = 'changed'; },
    'accepted mismatch even freshly captured target': f => { f.target.head = 'other'; f.request.targetDigest = effectArgsDigest(f.target); },
    'resolution bytes changed': f => writeFile(f.resolution.ref, '{"predecessorMerged":false}'),
    'source bytes changed': f => writeFile(f.source.path, 'changed'),
    'stale ledger': f => { f.request.ledgerDigest = hash('other'); },
    'mixed clarification': f => { f.request.clarification = { id: 'fake', digest: hash('fake') }; },
    'unresolved intent': async f => { await createLedgerStore(f.root).withLock('u', ledger => ledger.append({ event: 'intent', unit: 'u', seq: 1, key: 'pending', effect: 'session.start', args: {} })); await f.refresh(); },
    'latest result uncertain after completed': async f => {
      await createLedgerStore(f.root).withLock('u', async ledger => {
        await ledger.append({ event: 'intent', unit: 'u', seq: 1, key: 'pending', effect: 'session.start', args: {} });
        for (const status of ['completed', 'uncertain']) await ledger.append({ event: 'result', unit: 'u', seq: 1, key: 'pending', result: { status } });
      }); await f.refresh(); },
    'completion reservation': async f => { await f.goals.transaction('g', goal => ({ ...goal, revision: goal.revision + 1, completionReservation: { unit: 'u' } }));
      await f.store.update('u', r => ({ ...r, stopReport: { ...r.stopReport, goalRevision: f.request.expectedRevision + 1 } })); await f.refresh(); },
    'unfinished stage': async f => { await f.store.update('u', r => ({ ...r, stages: [{ name: 'implement', attempts: [{ n: 1 }] }] })); await f.refresh(); },
    'delivery already planned': async f => { await f.store.update('u', r => ({ ...r, deliveryPlan: { level: 'merge' } })); await f.refresh(); },
    'product failure not external wait': async f => {
      const p = path.join(f.root, f.goal.goal.blocker.evidence), failure = JSON.parse(await readFile(p, 'utf8'));
      const bytes = JSON.stringify({ ...failure, class: 'product' }); await writeFile(p, bytes);
      await f.store.update('u', r => ({ ...r, failures: r.failures.map(ref => ref.path === f.goal.goal.blocker.evidence ? { ...ref, digest: hash(bytes) } : ref) })); await f.refresh(); },
    'resolution changed during proof': f => { f.adapters.provider.verifyRetainedExternalResume = async input => {
      await writeFile(f.resolution.ref, 'changed after proof'); return { ...input, verified: true, externalResolved: true }; }; },
    'target changed during proof': f => { f.adapters.provider.verifyRetainedExternalResume = async input => {
      f.target.head = 'changed after proof'; return { ...input, verified: true, externalResolved: true }; }; },
  };
  for (const [name, prepare] of Object.entries(cases)) await t.test(name, async t => {
    const f = await fixture(t); await prepare(f);
    const record = await f.store.read('u'), goal = await f.goals.read('g');
    const result = await f.activate(); assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.deepEqual(await f.store.read('u'), record); assert.deepEqual(await f.goals.read('g'), goal); assert.equal(f.effects(), 0);
  });
});

test('external receipt cannot authorize different payloads or a changed target after goal commit', async t => {
  const f = await fixture(t); assert.equal((await f.activate()).code, 0);
  assert.notEqual((await f.activate({ ...f.request, reason: 'different' })).code, 0);
  f.target.contentFingerprint = 'changed';
  const file = path.join(f.root, 'snapshot.json'); await writeFile(file, JSON.stringify(f.snapshot));
  assert.notEqual((await f.cli(['unit', 'resume', 'u', '--snapshot', file])).code, 0);
  assert.deepEqual(await f.store.read('u'), f.record); assert.equal((await f.goals.read('g')).retainedExternalResumptions.length, 1);
});

test('external resume preserves inspection boundaries and invalidates every gate even when only one fingerprint drifted', async t => {
  const f = await fixture(t); assert.equal((await f.activate()).code, 0);
  const file = path.join(f.root, 'snapshot.json');
  await writeFile(file, JSON.stringify({ git: f.snapshot.git }));
  const incomplete = await f.cli(['unit', 'resume', 'u', '--snapshot', file]);
  assert.equal(incomplete.recovery.action, 'inspect-evidence'); assert.deepEqual(await f.store.read('u'), f.record);
  await writeFile(file, JSON.stringify({ ...f.snapshot, currentFingerprints: { ...f.snapshot.currentFingerprints, lint: hash('new lint inputs') } }));
  const resumed = await f.cli(['unit', 'resume', 'u', '--snapshot', file]);
  assert.equal(resumed.code, 0, JSON.stringify(resumed)); assert.equal(resumed.recovery.action, 'revalidate');
  const record = await f.store.read('u');
  assert.equal(record.evidence.length, f.record.evidence.length * 2);
  assert.ok(record.evidence.slice(f.record.evidence.length).every(item => item.status === 'stale' && item.covers.length === 0));
});
