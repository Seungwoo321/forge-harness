import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { createProjectionQueue } from './lib/tracker.mjs';
import { taskDigest } from './lib/session-task.mjs';
import { validateGoalCompletion } from './lib/continuity-completion.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { correctionSource, productAcceptance, describeAcceptanceGate } from './lib/acceptance-correction.mjs';
import { gateFingerprint } from './lib/evidence.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { executeDelivery } from './lib/delivery-flow.mjs';

const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const parse = output => JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));

async function fixture(t, { owner = 'engine' } = {}) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'acceptance-correction-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, 'state'), store = createUnitStateStore(stateRoot), unit = 'unit-a';
  const acceptance = Array.from({ length: 6 }, (_, i) => ({ id: `AC-${i + 1}`, text: [
    'Adds valid integers', 'Rejects a noninteger operand', 'Rejects an unsafe sum', 'Preserves zero',
    'Repository identity and policy are verified', 'Commit, push and open a pull request',
  ][i], status: 'open' }));
  const target = { head: 'head-1', contentFingerprint: 'content-1', repo: 'example/product', branch: 'fix/validation',
    base: 'main', tree: 'tree-1', indexTree: 'tree-1', headTree: 'tree-0' };
  await store.create({ schema: 'harness.unit/1', unit, kind: 'impl', state: 'SelfGated',
    request: { text: 'Implement addition and verify delivery authority', userInputRef: 'original-request' },
    canon: [], acceptance, policy: { goal: { class: 'product-prelaunch' }, delivery: owner === 'external' ? 'none' : 'pr', review: { mode: 'required', by: 'session', triggers: [] }, retry: { maxPerSignature: 2, maxResolver: 2 } },
    stages: [{ name: 'implement', attempt: 1, submittedAt: '2026-01-01', checkpoint: 'checkpoint-implement', checkpointHead: target.head }],
    scopePaths: ['product.mjs'], changedPaths: [], assumptions: [], diff: null, handoff: null,
    evidence: [{ gate: 'acceptance-coverage', status: 'failed', exit: 1, covers: [], report: 'original-failure' }],
    failures: [{ signature: 'coverage-mismatch', path: 'failure.json', digest: 'original' }], findings: [], openDecisions: [],
    reviewDecision: { head: target.head, contentFingerprint: target.contentFingerprint, required: true }, reviewedHead: target.head, verdict: 'ship' });
  const source = correctionSource(await store.read(unit));
  const authority = { sourceDigest: effectArgsDigest(source), kinds: { 'AC-5': 'observation', 'AC-6': 'delivery' }, level: 'pr', owner };
  const provenancePath = path.join(cwd, 'authority.json');
  await writeFile(provenancePath, JSON.stringify(authority));
  const evidencePath = path.join(cwd, 'identity.json');
  const observation = { unit, head: target.head, contentFingerprint: target.contentFingerprint, repo: target.repo, policy: 'verified', valid: true };
  await writeFile(evidencePath, JSON.stringify(observation));
  const provenance = { ref: provenancePath, digest: bytesDigest(await readFile(provenancePath)) };
  let authorized = true, revoked = false, wrongBinding = false, onVerify = null;
  const trace = [], results = new Map();
  const provider = {
    async verifyUserInput(input) { return { ...input, verified: authorized && input.userInputRef === 'user-correction' }; },
    async verifyAcceptanceCorrection(input) {
      const { request, source: actualSource, target: inspected, ...binding } = input;
      let verified = false;
      try {
        const original = await readFile(provenancePath), proof = await readFile(request.provenance.ref);
        const parsed = JSON.parse(proof);
        verified = !revoked && proof.equals(original) && bytesDigest(proof) === request.provenance.digest
          && effectArgsDigest(actualSource) === authority.sourceDigest && parsed.sourceDigest === input.sourceDigest
          && authority.kinds[request.acceptanceRef] === request.kind;
        if (request.kind === 'observation') {
          const bytes = await readFile(request.evidence.ref), data = JSON.parse(bytes);
          verified &&= bytesDigest(bytes) === request.evidence.digest && data.unit === unit && data.head === request.head
            && data.contentFingerprint === request.contentFingerprint && data.repo === target.repo && data.policy === 'verified' && data.valid === true;
        } else verified &&= request.level === authority.level && request.owner === authority.owner;
      } catch { verified = false; }
      if (onVerify) await onVerify();
      return { ...binding, verified, ...(wrongBinding ? { argsDigest: 'forged' } : {}) };
    },
  };
  const methods = {
    async deliveryContext() { return { resourceOwned: true, productOwned: true, inScope: true, operational: false,
      irreversible: false, containsSecret: false, forbiddenCommand: false, explicitUserInstruction: true }; },
    async execute(input) {
      trace.push(input.effect);
      let result;
      if (input.effect === 'git.commit') {
        result = { sha: 'commit-1', parent: target.head, tree: target.tree, contentFingerprint: target.contentFingerprint };
        target.headParent = target.head; target.head = result.sha; target.headTree = target.tree;
      } else if (input.effect === 'git.push') result = { head: target.head };
      else if (input.effect === 'pr.create') result = { ...input.args, status: 'open', pr: 1 };
      results.set(input.key, result); return result;
    },
    async verify(input) {
      const result = results.get(input.key), verify = { adapter: 'repository', operation: 'inspect', args: input.args };
      return result ? { status: input.effect === 'pr.create' ? 'open' : 'completed', ...result, result, verify } : { status: 'not-found', verify };
    },
  };
  const core = createAdapters({ repositoryRoot: cwd });
  const adapters = { ...core, now: () => '2026-01-01T00:00:00Z', provider, git: { inspectUnit: async () => ({ ...target }), ...methods }, repository: methods,
    checkpoint: {
      async createCheckpoint({ ref }) { return { commit: `checkpoint:${ref}`, worktreeChanged: false, indexChanged: false, excluded: [] }; },
      async inspectChanges() { return { head: target.head, tree: target.tree, firstCheckpointDiff: [], attemptDiff: [], patch: '' }; },
    },
  };
  const product = `export function add(a,b){if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b))throw new TypeError('integer');const n=a+b;if(!Number.isSafeInteger(n))throw new RangeError('overflow');return n}`;
  const tests = `import assert from 'node:assert/strict';import {add} from './product.mjs';
 console.log('TAP version 13\\n1..4');
 assert.equal(add(2,3),5);console.log('ok 1 - AC-1 addition');
 assert.throws(()=>add(1.5,2),TypeError);console.log('ok 2 - AC-2 noninteger');
 assert.throws(()=>add(Number.MAX_SAFE_INTEGER,1),RangeError);console.log('ok 3 - AC-3 overflow');
 assert.equal(add(0,0),0);console.log('ok 4 - AC-4 zero');`;
  const scanner = `import {readFileSync} from 'node:fs';const ids=JSON.parse(process.argv[2]);const source=readFileSync('product.test.mjs','utf8');const covers=ids.filter(id=>source.includes(id));const ok=covers.length===ids.length;console.log(JSON.stringify({ok,covers}));if(!ok)process.exitCode=1;`;
  for (const [name, bytes] of [['product.mjs', product], ['product.test.mjs', tests], ['scanner.mjs', scanner]]) await writeFile(path.join(cwd, name), bytes);
  adapters.gates = { async describe(id, { record }) {
    if (id === 'acceptance-coverage') return { id, command: [process.execPath, 'scanner.mjs', JSON.stringify(record.acceptance.map(item => item.id))],
      files: [{ path: 'scanner.mjs', content: scanner }, { path: 'product.test.mjs', content: await readFile(path.join(cwd, 'product.test.mjs')) }], format: 'exec', resultFormat: 'json' };
    return { id, command: [process.execPath, 'product.test.mjs'], files: [
      { path: 'product.mjs', content: await readFile(path.join(cwd, 'product.mjs')) },
      { path: 'product.test.mjs', content: await readFile(path.join(cwd, 'product.test.mjs')) },
    ], format: 'tap', acPattern: 'AC-[0-9]+' };
  } };
  const read = () => store.read(unit);
  const run = async (args) => parse(await runUnitCli(['unit', ...args], { cwd, stateRoot, adapters }));
  const request = async (overrides = {}) => {
    const r = await read();
    const acceptanceRef = overrides.acceptanceRef ?? 'AC-5';
    return { id: 'observation-1', expectedRevision: r.revision, acceptanceRef,
      criterionDigest: effectArgsDigest(r.acceptance.find(item => item.id === acceptanceRef)), sourceDigest: effectArgsDigest(correctionSource(r)),
      head: target.head, contentFingerprint: target.contentFingerprint, kind: 'observation', provenance,
      evidence: { ref: evidencePath, digest: bytesDigest(await readFile(evidencePath)) }, reason: 'Correct the demonstrated evidence recording mismatch', ...overrides };
  };
  const correct = async (body) => { const file = path.join(cwd, `${body.id}.json`); await writeFile(file, JSON.stringify(body));
    return run(['acceptance', 'correct', unit, '--request', file, '--user-input', 'user-correction']); };
  const deliveryRequest = async () => { const r = await request({ id: 'delivery-1', acceptanceRef: 'AC-6', kind: 'delivery', level: 'pr', owner }); delete r.evidence; return r; };
  const both = async () => { assert.equal((await correct(await request())).code, 0); assert.equal((await correct(await deliveryRequest())).code, 0); };
  return { cwd, stateRoot, store, unit, read, run, request, correct, deliveryRequest, both, adapters, target, trace, evidencePath, provenancePath,
    revoke: () => { revoked = true; }, deny: () => { authorized = false; }, wrongBinding: () => { wrongBinding = true; },
    onVerify: callback => { onVerify = callback; } };
}

test('public same-unit corrections preserve all requirements and history, are audited and idempotent', async t => {
  const f = await fixture(t), before = await f.read(), request = await f.request();
  const progress = await f.run(['progress', f.unit]);
  assert.equal(progress.correctionSourceDigest, request.sourceDigest);
  assert.equal(progress.criterionDigests[4].digest, request.criterionDigest);
  const initialGate = await describeAcceptanceGate(f.adapters, 'acceptance-coverage', f.unit, before);
  const result = await f.correct(request); assert.equal(result.code, 0, JSON.stringify(result));
  const after = await f.read();
  for (const key of ['acceptance', 'request', 'canon', 'policy', 'stages', 'evidence', 'failures', 'findings']) assert.deepEqual(after[key], before[key]);
  assert.equal(after.policy.review.mode, 'required'); assert.equal(after.policy.retry.maxPerSignature, 2);
  assert.equal(after.verdict, null); assert.equal(after.reviewDecision, null);
  assert.deepEqual(after.acceptanceCorrections[0].previousReview.reviewDecision, before.reviewDecision);
  assert.equal(after.acceptanceCorrections[0].requestDigest, effectArgsDigest({ request, userInputRef: 'user-correction' }));
  assert.equal((await f.correct(request)).correction.duplicate, true); assert.deepEqual(await f.read(), after);
  assert.equal((await f.correct({ ...request, reason: 'another reason' })).error, 'ACCEPTANCE_CORRECTION_CONFLICT');
  const nextGate = await describeAcceptanceGate(f.adapters, 'acceptance-coverage', f.unit, after);
  assert.notEqual(gateFingerprint(initialGate), gateFingerprint(nextGate));
  assert.deepEqual(productAcceptance(after).map(item => item.id), ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-6']);
});

test('forged provenance, product reclassification, unauthorized dropping and stale requests never write', async t => {
  const f = await fixture(t), request = await f.request(), before = await f.read();
  const cases = [
    [{ ...request, status: 'dropped' }, 'ACCEPTANCE_CORRECTION_INVALID'],
    [{ ...request, kind: 'test-waiver' }, 'ACCEPTANCE_CORRECTION_INVALID'],
    [{ ...request, acceptance: [] }, 'ACCEPTANCE_CORRECTION_INVALID'],
    [{ ...request, criterionDigest: [request.criterionDigest] }, 'ACCEPTANCE_CORRECTION_INVALID'],
    [{ ...request, evidence: { ref: f.evidencePath, digest: `sha256:${'0'.repeat(64)}` } }, 'ACCEPTANCE_CORRECTION_UNPROVEN'],
    [{ ...request, provenance: { ...request.provenance, digest: `sha256:${'0'.repeat(64)}` } }, 'ACCEPTANCE_CORRECTION_UNPROVEN'],
    [{ ...request, sourceDigest: `sha256:${'0'.repeat(64)}` }, 'ACCEPTANCE_CORRECTION_STALE'],
    [await f.request({ acceptanceRef: 'AC-1' }), 'ACCEPTANCE_CORRECTION_UNPROVEN'],
    [{ ...request, criterionDigest: effectArgsDigest(before.acceptance[0]) }, 'ACCEPTANCE_CORRECTION_STALE'],
    [{ ...request, expectedRevision: request.expectedRevision + 1 }, 'ACCEPTANCE_CORRECTION_STALE'],
    [{ ...request, head: 'old-head' }, 'ACCEPTANCE_CORRECTION_STALE'],
  ];
  for (const [body, code] of cases) { assert.equal((await f.correct(body)).error, code, JSON.stringify(body)); assert.deepEqual(await f.read(), before); }
  f.wrongBinding(); assert.equal((await f.correct(request)).error, 'ACCEPTANCE_CORRECTION_UNPROVEN');
  f.deny(); assert.equal((await f.correct(request)).error, 'EFFECT_APPROVAL_REQUIRED'); assert.deepEqual(await f.read(), before);
});

test('open stages, unresolved effects, blocked states and races cannot change the unit', async t => {
  const f = await fixture(t);
  await f.store.update(f.unit, r => ({ ...r, stages: [{ name: 'implement', attempt: 1, startedAt: 'earlier' }] }));
  assert.equal((await f.correct(await f.request())).error, 'INVALID_TRANSITION');
  await f.store.update(f.unit, r => ({ ...r, stages: [] }));
  const ledger = createLedgerStore(f.stateRoot);
  await ledger.withLock(f.unit, l => l.append({ event: 'intent', seq: 1, key: 'unresolved', effect: 'git.push' }));
  assert.equal((await f.correct(await f.request())).error, 'EFFECT_UNCERTAIN');
  await ledger.withLock(f.unit, l => l.append({ event: 'result', seq: 1, key: 'unresolved', result: { status: 'uncertain' } }));
  assert.equal((await f.correct(await f.request())).error, 'EFFECT_UNCERTAIN');
  await ledger.withLock(f.unit, l => l.append({ event: 'result', seq: 1, key: 'unresolved', result: { status: 'completed' } }));
  await f.store.update(f.unit, r => ({ ...r, state: 'Blocked', blockedFrom: 'SelfGated' }));
  const blocked = await f.read(); assert.equal((await f.correct(await f.request())).error, 'INVALID_TRANSITION'); assert.deepEqual(await f.read(), blocked);
  await f.store.update(f.unit, r => ({ ...r, state: 'SelfGated', blockedFrom: null }));
  const before = await f.read(); f.onVerify(() => { f.target.head = 'external'; });
  assert.equal((await f.correct(await f.request())).error, 'ACCEPTANCE_CORRECTION_STALE'); assert.deepEqual(await f.read(), before);
});

test('concurrent corrections serialize at the expected revision', async t => {
  const f = await fixture(t), a = await f.request(), b = await f.deliveryRequest();
  const results = await Promise.all([f.correct(a), f.correct(b)]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.equal(results.find(r => r.code !== 0).error, 'ACCEPTANCE_CORRECTION_STALE');
  assert.equal((await f.read()).acceptanceCorrections.length, 1);
});

test('real product tests and scanner run for four product criteria; observations and delivery never become test coverage', async t => {
  const f = await fixture(t); await f.both();
  const result = await f.run(['accept', f.unit]); assert.equal(result.code, 20, JSON.stringify(result));
  const record = await f.read(); assert.equal(record.state, 'InReview'); assert.equal(record.reviewDecision.required, true);
  assert.deepEqual(record.acceptance.map(item => item.id), ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']);
  for (const proof of record.evidence.slice(1)) {
    assert.equal(proof.status, 'passed'); assert.equal(proof.execution.kind, 'isolated-snapshot-v1');
    assert.deepEqual(proof.covers, ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
  }
  assert.equal(record.evidence[0].status, 'failed'); assert.equal(f.trace.length, 0);
  const progress = await f.run(['progress', f.unit]); assert.equal(progress.progress.covered, 4);
});

test('missing product evidence stays a failure and revoked or changed observation evidence blocks acceptance', async t => {
  const f = await fixture(t); await f.both();
  const tests = await readFile(path.join(f.cwd, 'product.test.mjs'), 'utf8');
  await writeFile(path.join(f.cwd, 'product.test.mjs'), tests.replace('AC-4', 'unmarked'));
  const result = await f.run(['accept', f.unit]); assert.equal(result.code, 1); assert.equal((await f.read()).state, 'SelfGated');
  assert.equal((await f.read()).evidence.at(-1).gate, 'acceptance-coverage'); assert.equal((await f.read()).evidence.at(-1).status, 'failed');
  await writeFile(f.evidencePath, JSON.stringify({ valid: false }));
  const before = await f.read(); assert.equal((await f.run(['accept', f.unit])).error, 'ACCEPTANCE_CORRECTION_UNPROVEN'); assert.deepEqual(await f.read(), before);
});

test('review input carries the full audit and post-review acceptance revalidates the corrections', async t => {
  const f = await fixture(t); await f.both();
  assert.equal((await f.run(['accept', f.unit])).code, 20);
  const opened = await f.run(['stage', 'open', f.unit, 'review']); assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  assert.equal(input.data.acceptance.length, 6); assert.equal(input.data.handoff.acceptanceCorrections.length, 2);
  const outputFile = path.join(f.cwd, 'review-output.json');
  await writeFile(outputFile, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'review-submission',
    status: 'done', summary: 'Product evidence and corrected obligations checked', findings: [], verdict: 'ship', reviewedHead: input.head }));
  const submitted = await f.run(['stage', 'submit', f.unit, 'review', '--output', outputFile]); assert.equal(submitted.code, 0, JSON.stringify(submitted));
  const result = await f.run(['accept', f.unit]); assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.read()).accepted.basis, 'review'); assert.deepEqual(result.coverage.covered, ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
});

test('revocation during gate execution is caught before opening review', async t => {
  const f = await fixture(t); await f.both();
  const describe = f.adapters.gates.describe;
  f.adapters.gates.describe = async (...args) => { const gate = await describe(...args); if (args[0] === 'acceptance-coverage') f.revoke(); return gate; };
  const result = await f.run(['accept', f.unit]); assert.equal(result.error, 'ACCEPTANCE_CORRECTION_UNPROVEN');
  assert.equal((await f.read()).state, 'SelfGated'); assert.equal((await f.read()).accepted, undefined);
});

test('changed authority is stale, and a target refresh retains old receipts and requires actual fresh evidence', async t => {
  const f = await fixture(t); await f.both(); const before = await f.read();
  await f.store.update(f.unit, r => ({ ...r, canon: [{ path: 'policy.md', digest: 'changed' }] }));
  assert.equal((await f.run(['accept', f.unit])).error, 'ACCEPTANCE_CORRECTION_STALE');
  await f.store.update(f.unit, r => ({ ...r, canon: before.canon }));
  f.target.head = 'head-2'; f.target.contentFingerprint = 'content-2';
  assert.equal((await f.correct(await f.request({ id: 'stale-observation' }))).error, 'ACCEPTANCE_CORRECTION_UNPROVEN');
  await writeFile(f.evidencePath, JSON.stringify({ unit: f.unit, head: f.target.head, contentFingerprint: f.target.contentFingerprint, repo: f.target.repo, policy: 'verified', valid: true }));
  assert.equal((await f.correct(await f.request({ id: 'fresh-observation' }))).code, 0);
  assert.equal((await f.correct({ ...await f.deliveryRequest(), id: 'fresh-delivery' })).code, 0);
  const after = await f.read(); assert.equal(after.acceptanceCorrections.length, 4);
  assert.deepEqual(after.acceptanceCorrections.slice(0, 2), before.acceptanceCorrections);
  assert.deepEqual(after.acceptance, before.acceptance); assert.deepEqual(after.failures, before.failures);
});

test('delivery obligations reject weaker policy or finish, then verified commit, push and PR satisfy the real boundary', async t => {
  const f = await fixture(t); await f.both();
  const file = path.join(f.cwd, 'policy.json');
  await writeFile(file, JSON.stringify({ id: 'downgrade', expectedRevision: (await f.read()).revision, delivery: 'none', reason: 'Drop delivery' }));
  assert.equal((await f.run(['policy', 'change', f.unit, '--request', file, '--user-input', 'user-correction'])).error, 'DELIVERY_OBLIGATION_REQUIRED');
  const accepted = { ...f.target, validatedHead: f.target.head, basis: 'review' };
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted, evidence: [] }));
  for (const requestedDelivery of ['none', 'commit', 'push']) {
    await assert.rejects(executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: f.unit, requestedDelivery, adapters: f.adapters }), { code: 'DELIVERY_OBLIGATION_REQUIRED' });
  }
  assert.equal(f.trace.length, 0); assert.equal((await f.read()).state, 'Accepted');
  const outcome = await executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: f.unit, requestedDelivery: 'pr', adapters: f.adapters });
  assert.equal(outcome.code, 0, JSON.stringify(outcome)); assert.equal((await f.read()).state, 'Delivered');
  assert.deepEqual(f.trace, ['git.commit', 'git.push', 'pr.create']);
  assert.deepEqual((await f.read()).deliveryResult.effectRefs.map(ref => ref.effect), f.trace);
  assert.equal((await f.read()).accepted.validatedHead, 'head-1');
});

test('stale observation after acceptance prevents delivery effects and cannot be refreshed by forged content', async t => {
  const f = await fixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  f.revoke();
  await assert.rejects(executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: f.unit, requestedDelivery: 'pr', adapters: f.adapters }), { code: 'ACCEPTANCE_CORRECTION_UNPROVEN' });
  assert.equal(f.trace.length, 0); assert.equal((await f.read()).state, 'Accepted');
});

test('revoked operational evidence also blocks the public irreversible effect path before its ledger intent', async t => {
  const f = await fixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  f.adapters.effect = f.adapters.repository;
  f.adapters.effectContext = async () => ({ ...await f.adapters.git.deliveryContext(), irreversible: true });
  const file = path.join(f.cwd, 'push-args.json');
  await writeFile(file, JSON.stringify({ repo: f.target.repo, branch: f.target.branch, head: f.target.head }));
  f.revoke();
  const result = await f.run(['effect', f.unit, '--effect', 'git.push', '--args', file]);
  assert.equal(result.error, 'ACCEPTANCE_CORRECTION_UNPROVEN'); assert.equal(f.trace.length, 0);
  assert.deepEqual(await createLedgerStore(f.stateRoot).withLock(f.unit, ledger => ledger.read()), []);
});

test('an interrupted delivery commit reconciles on the same unit without replaying the commit or losing obligations', async t => {
  const f = await fixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  const execute = f.adapters.git.execute;
  f.adapters.git.execute = async input => { const result = await execute(input); if (input.effect === 'git.commit') throw new Error('lost response'); return result; };
  const run = () => executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: f.unit, requestedDelivery: 'pr', adapters: f.adapters });
  assert.equal((await run()).code, 3); assert.equal((await f.read()).state, 'Delivering');
  assert.equal((await run()).code, 0); assert.equal((await f.read()).state, 'Delivered');
  assert.deepEqual(f.trace, ['git.commit', 'git.push', 'pr.create']);
  assert.equal((await f.read()).acceptanceCorrections.length, 2);
});

test('a foreign head with the same content still requires reacceptance before delivery', async t => {
  const f = await fixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  f.target.head = 'foreign-head';
  const outcome = await executeDelivery({ stateRoot: f.stateRoot, store: f.store, unit: f.unit, requestedDelivery: 'pr', adapters: f.adapters });
  assert.equal(outcome.code, 1); assert.equal((await f.read()).state, 'SelfGated'); assert.equal(f.trace.length, 0);
});

test('a later correction cannot lower delivery or change classification, and missing verifiers fail closed', async t => {
  const f = await fixture(t); await f.both();
  const delivery = await f.deliveryRequest();
  assert.equal((await f.correct({ ...delivery, id: 'weaker', level: 'push' })).error, 'ACCEPTANCE_CORRECTION_INVALID');
  assert.equal((await f.correct({ ...delivery, id: 'external-owner', owner: 'external' })).error, 'ACCEPTANCE_CORRECTION_INVALID');
  assert.equal((await f.correct(await f.request({ id: 'switch', acceptanceRef: 'AC-6' }))).error, 'ACCEPTANCE_CORRECTION_INVALID');
  delete f.adapters.provider.verifyAcceptanceCorrection;
  const before = await f.read(); assert.equal((await f.correct(await f.request({ id: 'refresh' }))).error, 'ADAPTER_MISSING'); assert.deepEqual(await f.read(), before);
});

test('the public executable loads the correction provider and returns an audited same-unit receipt', async t => {
  const f = await fixture(t), request = await f.request();
  const requestFile = path.join(f.cwd, 'request.json'), adapterFile = path.join(f.cwd, 'provider.mjs');
  await writeFile(requestFile, JSON.stringify(request));
  // Synthetic authority is embedded in the verifier, independent of the request file.
  await writeFile(adapterFile, `import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
 export function createRuntimeAdapters(){return {git:{async inspectUnit(){return ${JSON.stringify(f.target)}}},provider:{
 async verifyUserInput(input){return {...input,verified:input.userInputRef==='user-correction'&&input.effect==='unit.acceptance.correct'&&input.argsDigest===${JSON.stringify(effectArgsDigest({ request, userInputRef: 'user-correction' }))}}},
 async verifyAcceptanceCorrection(input){const {request,source,...binding}=input;const bytes=await readFile(request.evidence.ref);return {...binding,verified:input.sourceDigest===${JSON.stringify(request.sourceDigest)}&&request.acceptanceRef==='AC-5'&&request.kind==='observation'&&'sha256:'+createHash('sha256').update(bytes).digest('hex')===request.evidence.digest}}}}}`);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./unit.mjs', import.meta.url)), 'unit', 'acceptance', 'correct', f.unit,
    '--request', requestFile, '--user-input', 'user-correction', '--adapters', adapterFile, '--state-root', f.stateRoot, '--project-root', f.cwd], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout); assert.equal(parse(child.stdout).correction.request.acceptanceRef, 'AC-5');
  assert.equal((await f.read()).acceptanceCorrections.length, 1);
});

async function externalFixture(t) {
  const f = await fixture(t, { owner: 'external' });
  f.target.headTree = f.target.tree;
  // This host deliberately owns no delivery execution capabilities.
  f.adapters.git = { inspectUnit: f.adapters.git.inspectUnit };
  delete f.adapters.repository;
  const evidencePath = path.join(f.cwd, 'external-pr.json');
  let wrongBinding = false;
  f.adapters.provider.verifyExternalDelivery = async input => {
    const { request, source, accepted, target, ...binding } = input;
    let bytes, data;
    try { bytes = await readFile(evidencePath); data = JSON.parse(bytes); } catch { return { ...binding, verified: false }; }
    const verified = request.owner === 'external' && data.unit === f.unit && data.sourceDigest === input.sourceDigest
      && data.correctionDigest === input.correctionDigest && data.valid === true && data.pushed === true
      && data.validatedHead === (accepted.validatedHead ?? accepted.head)
      && ['repo', 'branch', 'base', 'head', 'contentFingerprint'].every(key => data[key] === target[key])
      && data.status === 'open';
    return { ...binding, verified, ...(wrongBinding ? { acceptedDigest: 'forged' } : {}),
      evidence: { ref: evidencePath, digest: bytesDigest(bytes) },
      delivery: Object.fromEntries(['level', 'repo', 'branch', 'base', 'head', 'contentFingerprint', 'pr', 'status'].map(key => [key, data[key]])) };
  };
  const publish = async (overrides = {}) => {
    const record = await f.read(), correction = record.acceptanceCorrections.findLast(item => item.request.acceptanceRef === 'AC-6');
    const data = { unit: f.unit, sourceDigest: correction.request.sourceDigest, correctionDigest: correction.requestDigest,
      validatedHead: record.accepted.validatedHead, ...f.target, valid: true, pushed: true, level: 'pr',
      pr: 'https://example.org/product/pull/9', status: 'open', ...overrides };
    await writeFile(evidencePath, JSON.stringify(data));
  };
  const owner = { sessionId: 'owner', incarnationId: 'owner-generation', cwd: f.cwd, closable: true,
    worker: { executable: 'worker', incarnationId: 'worker-generation', pid: 42 } };
  const recipient = { sessionId: 'recipient', incarnationId: 'recipient-generation', cwd: f.cwd, executable: 'worker' };
  const sessionEvents = [];
  const taskReceipt = input => ({ ...recipient, task: { schema: 'harness.task-receipt/1', effectKey: input.key,
    sessionId: recipient.sessionId, incarnationId: recipient.incarnationId, cwd: f.cwd, promptDigest: taskDigest('native request'),
    threadId: 'thread', requestId: 'request', turnId: 'turn', activityId: 'activity',
    packets: [{ path: input.args.resultPath, digest: input.args.resultDigest }] } });
  f.adapters.session = {
    async observe(input) { return input.recipient ? recipient : owner; },
    async execute(input) {
      sessionEvents.push(input.effect);
      return input.effect === 'session.deliver' ? taskReceipt(input) : { closed: true, sessionId: owner.sessionId, incarnationId: owner.incarnationId };
    },
    async verify(input) { return { status: 'completed', result: input.effect === 'session.deliver' ? taskReceipt(input)
      : { closed: true, sessionId: owner.sessionId, incarnationId: owner.incarnationId } }; },
  };
  const finishFile = path.join(f.cwd, 'finish.json');
  await writeFile(finishFile, JSON.stringify({ goalComplete: true, requestedDelivery: 'none', parentRuntime: owner, returnTo: recipient,
    resultFields: { title: 'Completed work', objective: 'Validate addition', acceptance: 'Product and operational evidence verified',
      tracking: 'none', decision: 'External delivery retained', changed: 'product.mjs', verification: 'Product tests and live PR evidence', remainingRisk: 'none', nextFirstAction: 'resume' } }));
  return { ...f, publish, sessionEvents, evidencePath, finish: () => f.run(['finish', f.unit, '--request', finishFile]),
    wrongExternalBinding: () => { wrongBinding = true; } };
}

async function acceptReviewedProduct(f) {
  assert.equal((await f.run(['accept', f.unit])).code, 20);
  const opened = await f.run(['stage', 'open', f.unit, 'review']); assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8')), outputFile = path.join(f.cwd, 'external-review.json');
  await writeFile(outputFile, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'external-review',
    status: 'done', summary: 'Product verified; external obligation retained for finish', findings: [], verdict: 'ship', reviewedHead: input.head }));
  assert.equal((await f.run(['stage', 'submit', f.unit, 'review', '--output', outputFile])).code, 0);
  const accepted = await f.run(['accept', f.unit]); assert.equal(accepted.code, 0, JSON.stringify(accepted));
  return accepted;
}

test('delivery:none accepts products before external PR, then finish and finalization require bound live PR evidence without execution adapters', async t => {
  const f = await externalFixture(t), original = await f.read();
  f.target.indexTree = 'tree-0'; f.target.headTree = 'tree-0';
  await f.both();
  const acceptance = await acceptReviewedProduct(f);
  assert.deepEqual(acceptance.coverage.covered, ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
  assert.equal((await f.read()).state, 'Accepted'); assert.deepEqual((await f.read()).policy, original.policy);
  assert.equal((await f.finish()).error, 'EXTERNAL_DELIVERY_UNPROVEN'); assert.equal((await f.read()).resultRef, undefined);
  assert.equal(f.sessionEvents.length, 0); assert.equal((await f.read()).externalDeliveryEvidence, undefined);
  // A genuine external commit changes only the accepted content's SHA, then the external actor pushes and opens a PR.
  f.target.headParent = f.target.head; f.target.head = 'external-commit'; f.target.headTree = f.target.tree; f.target.indexTree = f.target.tree;
  await f.publish();
  const finished = await f.finish(); assert.equal(finished.finalizePending, true, JSON.stringify(finished));
  const delivered = await f.read(); assert.equal(delivered.state, 'Delivered'); assert.equal(delivered.deliveryResult.level, 'none');
  assert.deepEqual(delivered.deliveryResult.effectRefs, []); assert.equal(delivered.accepted.validatedHead, 'head-1');
  assert.equal(delivered.accepted.head, 'external-commit'); assert.equal(delivered.reviewedHead, 'head-1');
  assert.ok(delivered.externalDeliveryEvidence.length > 0); assert.equal(delivered.externalDeliveryEvidence.at(-1).delivery.pr, 'https://example.org/product/pull/9');
  const evidenceCount = delivered.externalDeliveryEvidence.length;
  await f.publish({ valid: false });
  assert.equal((await f.run(['finalize', f.unit])).error, 'EXTERNAL_DELIVERY_UNPROVEN');
  assert.equal((await f.run(['close', f.unit])).error, 'EXTERNAL_DELIVERY_UNPROVEN');
  assert.equal(f.sessionEvents.length, 0); assert.equal((await f.read()).externalDeliveryEvidence.length, evidenceCount);
  f.target.headParent = f.target.head; f.target.head = 'external-commit-2';
  await f.publish();
  const finalized = await f.run(['finalize', f.unit]); assert.equal(finalized.code, 0, JSON.stringify(finalized));
  const closed = await f.read(); assert.equal(closed.state, 'Closed'); assert.deepEqual(closed.policy, original.policy);
  assert.equal(closed.accepted.head, 'external-commit-2'); assert.equal(closed.deliveryResult.head, closed.accepted.head);
  assert.deepEqual(closed.acceptance, original.acceptance); assert.deepEqual(closed.failures, original.failures);
  assert.deepEqual(f.sessionEvents, ['session.deliver', 'session.close']); assert.equal(f.trace.length, 0);
  const ledger = await createLedgerStore(f.stateRoot).withLock(f.unit, entries => entries.read());
  assert.equal(ledger.some(row => row.event === 'intent' && ['git.commit', 'git.push', 'pr.create', 'pr.merge'].includes(row.effect)), false);
});

test('missing, stale, forged or wrong-target external proofs never finish or write receipts', async t => {
  const f = await externalFixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  const before = await f.read();
  for (const override of [{ valid: false }, { pushed: false }, { head: 'stale-head' }, { repo: 'other/product' }, { base: 'other-base' },
    { correctionDigest: `sha256:${'0'.repeat(64)}` }, { status: 'closed' }, { level: 'push' }, { pr: '' }, { validatedHead: 'unrelated-source' }]) {
    await f.publish(override);
    assert.equal((await f.finish()).error, 'EXTERNAL_DELIVERY_UNPROVEN', JSON.stringify(override)); assert.deepEqual(await f.read(), before);
  }
  await f.publish(); f.wrongExternalBinding();
  assert.equal((await f.finish()).error, 'EXTERNAL_DELIVERY_UNPROVEN'); assert.deepEqual(await f.read(), before);
  delete f.adapters.provider.verifyExternalDelivery;
  assert.equal((await f.finish()).error, 'ADAPTER_MISSING'); assert.deepEqual(await f.read(), before);
  assert.equal(f.trace.length, 0); assert.equal(f.sessionEvents.length, 0);
});

test('external evidence cannot bless changed content or an unrelated same-tree commit', async t => {
  const f = await externalFixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  const before = await f.read();
  f.target.head = 'foreign-head'; f.target.headParent = 'foreign-parent'; f.target.headTree = f.target.tree;
  await f.publish(); assert.equal((await f.finish()).error, 'EXTERNAL_DELIVERY_UNPROVEN'); assert.deepEqual(await f.read(), before);
  f.target.headParent = 'head-1'; f.target.contentFingerprint = 'changed-content';
  await f.publish(); assert.equal((await f.finish()).error, 'ACCEPTANCE_CORRECTION_STALE'); assert.deepEqual(await f.read(), before);
});

test('queued terminal projection cannot bypass revoked external evidence', async t => {
  const f = await externalFixture(t); await f.both();
  await f.store.update(f.unit, r => ({ ...r, state: 'Accepted', accepted: { ...f.target, validatedHead: f.target.head }, evidence: [] }));
  await f.publish(); assert.equal((await f.finish()).finalizePending, true);
  await f.store.update(f.unit, r => ({ ...r, tracker: { adapter: 'stub', ref: 'ticket-1' }, terminalProjection: { revision: r.revision + 2 } }));
  const queue = createProjectionQueue(f.stateRoot, f.adapters);
  await queue.enqueue({ unit: f.unit, tracker: { ref: 'ticket-1' }, projection: { state: 'Closed', revision: (await f.read()).terminalProjection.revision }, terminal: true });
  let writes = 0;
  f.adapters.tracker = { read: async () => null, project: async () => { writes += 1; } };
  await f.publish({ valid: false });
  const result = await f.run(['reconcile', f.unit]); assert.equal(result.code, 3); assert.equal(writes, 0);
  assert.equal((await f.read()).state, 'Delivered'); assert.equal(f.sessionEvents.length, 0);
});

test('correction cannot switch delivery ownership and an external obligation survives unchanged none policy', async t => {
  const f = await externalFixture(t); await f.both(); const before = await f.read();
  assert.equal(before.policy.delivery, 'none');
  const switchRequest = { ...await f.deliveryRequest(), id: 'switch-owner', owner: 'engine' };
  assert.equal((await f.correct(switchRequest)).error, 'ACCEPTANCE_CORRECTION_INVALID'); assert.deepEqual(await f.read(), before);
});

test('goal preflight maps audited obligations without fake test coverage and completion still requires guarded closure', async t => {
  const f = await externalFixture(t); await f.both(); await acceptReviewedProduct(f);
  let record = await f.read();
  const continuity = { goal: { id: 'goal-1', status: 'active', remaining: [f.unit], criteria: record.acceptance.map(item => item.text) } };
  const proof = record.acceptance.map(item => ({ criterion: item.text, unit: f.unit, acceptance: item.id }));
  const unitStore = { read: async () => ({ ...record, continuity: { goalId: 'goal-1' } }) };
  assert.equal(await validateGoalCompletion({ continuity, unit: f.unit, proof, unitStore }), true);
  await assert.rejects(validateGoalCompletion({ continuity, unit: f.unit, proof, unitStore, requireClosed: true }), { code: 'GOAL_INCOMPLETE' });
  const original = structuredClone(record);
  record.acceptanceCorrections[0].requestDigest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(validateGoalCompletion({ continuity, unit: f.unit, proof, unitStore }), { code: 'GOAL_INCOMPLETE' });
  record = original;
  record.evidence = record.evidence.map(item => ({ ...item, covers: item.covers.filter(id => id !== 'AC-4') }));
  await assert.rejects(validateGoalCompletion({ continuity, unit: f.unit, proof, unitStore }), { code: 'GOAL_INCOMPLETE' });
  await f.publish(); assert.equal((await f.finish()).finalizePending, true);
  assert.equal((await f.run(['finalize', f.unit])).code, 0);
  record = await f.read();
  assert.equal(await validateGoalCompletion({ continuity, unit: f.unit, proof, unitStore, requireClosed: true }), true);
  assert.equal(record.evidence.some(item => item.covers.includes('AC-5') || item.covers.includes('AC-6')), false);
});
