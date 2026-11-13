import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
import { validateGoalCompletion } from './lib/continuity-completion.mjs';
import { clarifyGoalAcceptance, verifyGoalAcceptanceClarification, validateInitialGoalAcceptance } from './lib/goal-acceptance-binding.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'source.txt'), digest: hash('original obligations') };
  await writeFile(source.path, 'original obligations');
  const store = createUnitStateStore(root), goals = createContinuityStore(root);
  const policy = { runtime: 'cmux', provider: 'codex', account: '/fixture-account', model: 'model', effort: 'low', argv: ['codex'] };
  await goals.create({ goal: { id: 'g', objective: 'Complete original work', criteria: ['Original full obligation'], remaining: ['u'], status: 'active' }, source, policy });
  const owner = { unit: 'u', sessionId: 'owner', incarnationId: 'inc', cwd: root, nativeThreadId: 'thread' };
  await goals.transaction('g', g => ({ ...g, revision: g.revision + 1, bootstraps: [owner] }));
  const goal = await goals.read('g'), target = { head: 'head', contentFingerprint: 'content' };
  const evidence = ['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage'].map(gate => ({ gate, status: 'passed', exit: 0, covers: ['AC-1', 'AC-2'], failureClass: null,
    fingerprint: hash(gate), execution: { kind: 'isolated-snapshot-v1', fingerprint: hash(gate) } }));
  await store.create({ schema: 'harness.unit/1', unit: 'u', kind: 'impl', state: 'Accepted', continuity: { goalId: 'g' },
    request: { text: 'Original work', userInputRef: 'original-human', overallGoal: { id: 'g', objective: goal.goal.objective, criteria: goal.goal.criteria, source } },
    policy: { goal: { class: 'task' }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] }, retry: { maxPerSignature: 2 } },
    acceptance: [{ id: 'AC-1', text: 'First clause' }, { id: 'AC-2', text: 'Remaining clause' }], evidence, accepted: { ...target, basis: 'review' },
    head: target.head, contentFingerprint: target.contentFingerprint, reviewedHead: target.head, verdict: 'ship', reviewDecision: { required: true, contentFingerprint: target.contentFingerprint },
    failures: [{ id: 'original-failure', causeKey: 'original-signature' }], stages: [{ name: 'implement', attempts: [{ n: 1, endedAt: 'done' }] }] });
  const original = await store.read('u');
  const request = { id: 'clarification-1', expectedRevision: original.revision, expectedGoalRevision: goal.revision, unitDigest: effectArgsDigest(original),
    goalDigest: effectArgsDigest(goal), targetDigest: effectArgsDigest(target), mappings: [{ criterion: goal.goal.criteria[0], acceptanceRefs: ['AC-1', 'AC-2'], evidence: [{ ref: source.path, digest: source.digest }] }],
    provenance: { ref: source.path, digest: source.digest }, reason: 'Original source establishes both clauses' };
  const adapters = { now: () => '2026-01-01T00:00:00Z', git: { inspectUnit: async () => target }, session: { observe: async () => ({ ...owner, worker: { threadId: 'thread' } }) },
    provider: { verifyUserInput: async binding => ({ ...binding, verified: binding.userInputRef === 'original-human' }),
      verifyGoalAcceptanceClarification: async binding => ({ ...binding, verified: binding.request.provenance.digest === source.digest }) } };
  const run = (patch = {}) => clarifyGoalAcceptance({ stateRoot: root, store, unit: 'u', request, userInputRef: 'original-human', adapters, ...patch });
  const refresh = async () => { const r = await store.read('u'), g = await goals.read('g'); Object.assign(request, { expectedRevision: r.revision, unitDigest: effectArgsDigest(r), expectedGoalRevision: g.revision, goalDigest: effectArgsDigest(g) }); };
  return { root, source, store, goals, original, goal, owner, target, request, adapters, run, refresh };
}

test('AC-1 AC-2 public clarification preserves original obligations, evidence, review, failures, policy and custody', async t => {
  const f = await fixture(t), goalBytes = await readFile(path.join(f.root, 'goals/g/goal.json'));
  const requestPath = path.join(f.root, 'request.json'); await writeFile(requestPath, JSON.stringify(f.request));
  const output = await runUnitCli(['unit', 'goal-acceptance', 'clarify', 'u', '--request', requestPath, '--user-input', 'original-human'], { stateRoot: f.root, adapters: f.adapters });
  assert.equal(JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7)).code, 0, output);
  const record = await f.store.read('u'), { goalAcceptanceClarifications, revision, ...rest } = record;
  assert.deepEqual(rest, Object.fromEntries(Object.entries(f.original).filter(([key]) => key !== 'revision')));
  assert.equal(revision, f.original.revision + 1); assert.equal(goalAcceptanceClarifications.length, 1);
  assert.deepEqual(await readFile(path.join(f.root, 'goals/g/goal.json')), goalBytes);
  const proof = [{ criterion: f.goal.goal.criteria[0], unit: 'u', acceptances: ['AC-1', 'AC-2'] }];
  assert.equal(await validateGoalCompletion({ continuity: f.goal, unit: 'u', proof, unitStore: f.store }), true);
  await assert.rejects(validateGoalCompletion({ continuity: f.goal, unit: 'u', proof: [{ ...proof[0], acceptances: ['AC-1'] }], unitStore: f.store }));
  await verifyGoalAcceptanceClarification({ record, stateRoot: f.root, adapters: f.adapters, target: f.target });
  assert.equal((await f.run()).duplicate, true); assert.deepEqual(await f.store.read('u'), record);
  await assert.rejects(f.run({ request: { ...f.request, reason: 'different' } }), { code: 'GOAL_ACCEPTANCE_CONFLICT' });
});

test('AC-2 retained Stopped-from-Accepted recovery changes neither stop nor owner', async t => {
  const f = await fixture(t);
  await f.store.update('u', r => ({ ...r, state: 'Stopped', stoppedFrom: 'Accepted', stop: { reason: 'original binding failure' } })); await f.refresh();
  const before = await f.store.read('u'); await f.run(); const after = await f.store.read('u');
  for (const key of Object.keys(before).filter(key => key !== 'revision')) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(await f.goals.read('g'), f.goal);
});

test('AC-2 concurrent and post-commit crash replay records exactly one clarification', async t => {
  const f = await fixture(t); const outcomes = await Promise.all([f.run(), f.run()]);
  assert.equal(outcomes.filter(item => item.duplicate).length, 1);
  const restarted = createUnitStateStore(f.root), before = await restarted.read('u');
  assert.equal((await f.run({ store: restarted })).duplicate, true); assert.deepEqual(await restarted.read('u'), before);
});

test('AC-2 rejected authority, stale inputs, conflicting maps, drift and uncertain effects commit nothing', async t => {
  const cases = {
    unauthorized: f => { f.adapters.provider.verifyUserInput = async input => ({ ...input, verified: false }); },
    fabricated: f => { f.adapters.provider.verifyGoalAcceptanceClarification = async input => ({ ...input, verified: false }); },
    'missing verifier': f => { delete f.adapters.provider.verifyGoalAcceptanceClarification; },
    'wrong verifier binding': f => { f.adapters.provider.verifyGoalAcceptanceClarification = async input => ({ ...input, verified: true, targetDigest: hash('foreign') }); },
    'stale unit': f => { f.request.expectedRevision++; },
    'stale unit digest': f => { f.request.unitDigest = hash('stale'); },
    'stale goal': f => { f.request.expectedGoalRevision++; },
    'stale target': f => { f.request.targetDigest = hash('stale'); },
    'missing evidence': f => { f.request.mappings[0].evidence = []; },
    'invalid evidence digest': f => { f.request.mappings[0].evidence[0].digest = 'invented'; },
    'missing criterion': f => { f.request.mappings = []; },
    'foreign criterion': f => { f.request.mappings[0].criterion = 'narrower obligation'; },
    'duplicate criterion': f => { f.request.mappings.push(f.request.mappings[0]); },
    'duplicate AC': f => { f.request.mappings[0].acceptanceRefs.push('AC-1'); },
    'foreign AC': f => { f.request.mappings[0].acceptanceRefs = ['foreign']; },
    'changed source': f => writeFile(f.source.path, 'different'),
    'native drift': f => { f.adapters.session.observe = async () => ({ ...f.owner, sessionId: 'foreign' }); },
    'target drift': f => { let n = 0; f.adapters.git.inspectUnit = async () => ++n === 1 ? f.target : { ...f.target, head: 'foreign' }; },
    'uncertain effect': f => createLedgerStore(f.root).withLock('u', ledger => ledger.append({ event: 'intent', seq: 1, key: 'pending', effect: 'git.push', args: {} })),
    'precommit interruption': f => { f.adapters.provider.verifyGoalAcceptanceClarification = async () => { throw new Error('interrupted'); }; },
  };
  for (const [name, prepare] of Object.entries(cases)) await t.test(name, async t => {
    const f = await fixture(t); await prepare(f); const before = await f.store.read('u'), goal = await f.goals.read('g');
    await assert.rejects(f.run()); assert.deepEqual(await f.store.read('u'), before); assert.deepEqual(await f.goals.read('g'), goal);
  });
});

test('AC-2 accepted evidence, review and obligation drift invalidate recorded mappings', async t => {
  for (const key of ['acceptance', 'evidence', 'accepted', 'policy', 'request', 'reviewDecision']) await t.test(key, async t => {
    const f = await fixture(t); await f.run(); await f.store.update('u', r => ({ ...r, [key]: null }));
    await assert.rejects(verifyGoalAcceptanceClarification({ record: await f.store.read('u'), stateRoot: f.root, adapters: f.adapters, target: f.target }));
  });
});

test('AC-1 final initial binding rejects mismatch and retains every criterion without semantic guesses', async t => {
  const f = await fixture(t), record = f.original;
  const validate = acceptance => validateInitialGoalAcceptance({ record, acceptance, goal: f.goal, store: f.store });
  await assert.rejects(validate(record.acceptance), { code: 'GOAL_ACCEPTANCE_MISMATCH' });
  await validate([{ id: 'AC-1', text: f.goal.goal.criteria[0] }, { id: 'extra', text: 'Additional product requirement' }]);
  await assert.rejects(validate([{ id: 'AC-1', text: f.goal.goal.criteria[0], status: 'deferred' }]), { code: 'GOAL_ACCEPTANCE_MISMATCH' });
  const multi = { ...f.goal, goal: { ...f.goal.goal, remaining: ['u', 'next'], criteria: [...f.goal.goal.criteria, 'Future obligation'] } };
  const current = { ...record, request: { ...record.request, overallGoal: { ...record.request.overallGoal, criteria: multi.goal.criteria } } };
  await validateInitialGoalAcceptance({ record: current, acceptance: [{ id: 'AC-1', text: multi.goal.criteria[0] }], goal: multi, store: f.store });
});

test('AC-1 public scope submission rejects incompatible initial binding before implementation', async t => {
  const f = await fixture(t);
  await f.store.update('u', r => ({ ...r, state: 'Scoped', accepted: null, stages: [], acceptance: [], evidence: [], canon: [], isolation: 'worktree' }));
  const adapters = { ...f.adapters, command: async () => ({ exitCode: 0, stdout: `${f.root}/.git\n` }),
    checkpoint: { createCheckpoint: async ({ ref }) => ({ commit: ref, head: 'head', excluded: [], worktreeChanged: false, indexChanged: false }), inspectChanges: async () => ({ firstCheckpointDiff: [], attemptDiff: [] }) } };
  const cli = async args => { const output = await runUnitCli(args, { stateRoot: f.root, adapters }); return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7)); };
  const opened = await cli(['unit', 'stage', 'open', 'u', 'scope']); assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input));
  const output = { inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'scope-1', status: 'done', summary: 'Bind original goal',
    acceptance: f.original.acceptance, scopePaths: ['src/'] };
  const file = path.join(f.root, 'scope.json'); await writeFile(file, JSON.stringify(output));
  const before = await f.store.read('u'), rejected = await cli(['unit', 'stage', 'submit', 'u', 'scope', '--output', file]);
  assert.equal(rejected.error, 'GOAL_ACCEPTANCE_MISMATCH', JSON.stringify(rejected)); assert.deepEqual(await f.store.read('u'), before);
  output.acceptance = [{ id: 'AC-1', text: f.goal.goal.criteria[0] }]; await writeFile(file, JSON.stringify(output));
  assert.equal((await cli(['unit', 'stage', 'submit', 'u', 'scope', '--output', file])).code, 0);
  assert.equal((await f.store.read('u')).state, 'Implementing');
});


test('AC-2 process death before and after atomic commit safely replays the original request', async t => {
  for (const phase of ['before', 'after']) await t.test(phase, async t => {
    const f = await fixture(t), parameters = path.join(f.root, 'child.json');
    await writeFile(parameters, JSON.stringify({ root: f.root, request: f.request, target: f.target, owner: f.owner, phase }));
    const script = `
      import { readFile } from 'node:fs/promises';
      import { createUnitStateStore } from ${JSON.stringify(new URL('./lib/unit-state.mjs', import.meta.url).href)};
      import { clarifyGoalAcceptance } from ${JSON.stringify(new URL('./lib/goal-acceptance-binding.mjs', import.meta.url).href)};
      const p = JSON.parse(await readFile(process.argv[1]));
      const hold = async () => { console.log('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      const original = createUnitStateStore(p.root);
      const store = { ...original, update: async (...args) => { const result = await original.update(...args); if (p.phase === 'after') await hold(); return result; } };
      await clarifyGoalAcceptance({ stateRoot: p.root, store, unit: 'u', request: p.request, userInputRef: 'original-human',
        adapters: { now: () => '2026-01-01T00:00:00Z', git: { inspectUnit: async () => p.target }, session: { observe: async () => ({ ...p.owner, worker: { threadId: 'thread' } }) },
          provider: { verifyUserInput: async input => ({ ...input, verified: true }), verifyGoalAcceptanceClarification: async input => { if (p.phase === 'before') await hold(); return { ...input, verified: true }; } } } });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, parameters], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(errors || 'child exited before fault boundary'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const receipt = await f.run();
    assert.equal(receipt.duplicate ?? false, phase === 'after');
    const record = await f.store.read('u'); assert.equal(record.goalAcceptanceClarifications.length, 1); assert.equal(record.revision, f.original.revision + 1);
    assert.deepEqual(record.failures, f.original.failures); assert.deepEqual(await f.goals.read('g'), f.goal);
  });
});

test('AC-2 clarification cannot substitute product tests for real external delivery', async t => {
  const { executeDelivery } = await import('./lib/delivery-flow.mjs');
  const f = await fixture(t);
  Object.assign(f.target, { repo: 'example/project', branch: 'fix/behavior', base: 'main', tree: 'tree', indexTree: 'tree', headTree: 'tree' });
  await f.store.update('u', r => ({ ...r, accepted: { ...r.accepted, ...f.target } }));
  const original = await f.store.read('u');
  const correctionRequest = { id: 'external-1', expectedRevision: 1, acceptanceRef: 'AC-2', criterionDigest: effectArgsDigest(original.acceptance[1]),
    sourceDigest: effectArgsDigest({ request: original.request, canon: [], acceptance: original.acceptance }), head: f.target.head, contentFingerprint: f.target.contentFingerprint,
    kind: 'delivery', level: 'merge', owner: 'external', provenance: f.request.provenance, reason: 'Original source retains actual external delivery' };
  await f.store.update('u', r => ({ ...r, acceptanceCorrections: [{ request: correctionRequest, userInputRef: 'original-human', requestDigest: effectArgsDigest({ request: correctionRequest, userInputRef: 'original-human' }) }] }));
  f.adapters.provider.verifyAcceptanceCorrection = async input => ({ ...input, verified: true });
  await f.refresh(); f.request.targetDigest = effectArgsDigest(f.target); await f.run();
  const before = await f.store.read('u');
  await assert.rejects(executeDelivery({ stateRoot: f.root, store: f.store, unit: 'u', requestedDelivery: 'none', adapters: f.adapters }), { code: 'ADAPTER_MISSING' });
  assert.deepEqual(await f.store.read('u'), before);
  f.adapters.provider.verifyExternalDelivery = async input => ({ ...input, verified: true, evidence: { ref: 'observed-delivery', digest: hash('actual merged content') },
    delivery: { level: 'merge', ...f.target, pr: 'https://example.com/pr/1', status: 'merged', mergeHead: 'merged-head' } });
  assert.equal((await executeDelivery({ stateRoot: f.root, store: f.store, unit: 'u', requestedDelivery: 'none', adapters: f.adapters })).code, 0);
  const delivered = await f.store.read('u'); assert.equal(delivered.deliveryResult.level, 'none'); assert.equal(delivered.externalDeliveryEvidence.length, 1);
  assert.deepEqual(delivered.acceptanceCorrections, before.acceptanceCorrections); assert.deepEqual(delivered.goalAcceptanceClarifications, before.goalAcceptanceClarifications);
  f.adapters.provider.verifyExternalDelivery = async input => ({ ...input, verified: false });
  await assert.rejects(executeDelivery({ stateRoot: f.root, store: f.store, unit: 'u', requestedDelivery: 'none', adapters: f.adapters }), { code: 'EXTERNAL_DELIVERY_UNPROVEN' });
});

test('AC-3 clarification requires the configured full gate set and accepted independent review provenance', async t => {
  for (const patch of [{ evidence: [] }, { verdict: 'fix' }, { reviewedHead: 'foreign-head' }]) await t.test(Object.keys(patch)[0], async t => {
    const f = await fixture(t); await f.store.update('u', record => ({ ...record, ...patch })); await f.refresh();
    const before = await f.store.read('u'); await assert.rejects(f.run(), { code: 'GOAL_ACCEPTANCE_UNPROVEN' }); assert.deepEqual(await f.store.read('u'), before);
  });
});

test('AC-2 original-goal-only external obligations need actual target-bound outcomes at recovery and finish', async t => {
  const { finishSessionUnit } = await import('./lib/session-flow.mjs');
  const f = await fixture(t), file = path.join(f.root, 'actual-outcome.json');
  const bytes = JSON.stringify({ head: f.target.head, published: true, installed: true, originalCommandExit: 0 });
  await writeFile(file, bytes); f.request.mappings[0].evidence = [{ ref: file, digest: hash(bytes) }];
  f.adapters.provider.verifyGoalAcceptanceClarification = async input => {
    const evidence = input.request.mappings[0].evidence[0], observed = await readFile(evidence.ref), result = JSON.parse(observed);
    return { ...input, verified: hash(observed) === evidence.digest && result.head === input.target.head
      && result.published === true && result.installed === true && result.originalCommandExit === 0 };
  };
  await f.run();
  await writeFile(file, JSON.stringify({ head: 'foreign', published: true, installed: true, originalCommandExit: 0 }));
  const record = await f.store.read('u');
  await assert.rejects(finishSessionUnit({ stateRoot: f.root, store: f.store, unit: 'u', adapters: f.adapters }), { code: 'GOAL_ACCEPTANCE_UNPROVEN' });
  assert.deepEqual(await f.store.read('u'), record); assert.deepEqual(await f.goals.read('g'), f.goal);
});

test('AC-2 foreign, live and legacy crash markers are never removed', async t => {
  for (const marker of [{ pid: process.pid }, { pid: process.pid, protocol: 'harness.goal-acceptance-lock/1' },
    { pid: process.pid, protocol: 'harness.legacy-fence/1' }]) await t.test(marker.protocol ?? 'unmarked', async t => {
    const f = await fixture(t), file = path.join(f.root, 'units/u/.lock');
    const bytes = JSON.stringify({ ...marker, requestDigest: effectArgsDigest({ request: f.request, userInputRef: 'original-human' }) }); await writeFile(file, bytes);
    await assert.rejects(f.run(), { code: 'EFFECT_UNCERTAIN' }); assert.equal(await readFile(file, 'utf8'), bytes); assert.deepEqual(await f.store.read('u'), f.original);
  });
});

async function retainedCaller(t) {
  const f = await fixture(t), deliveries = new Map(); let effects = 0;
  f.adapters.id = () => 'original-binding-failure';
  const native = { ...f.owner, runtime: 'cmux', executable: '/bin/codex', closable: true,
    worker: { executable: '/bin/codex', pid: 12345, threadId: 'thread', incarnationId: 'worker-inc' } };
  const parent = { runtime: 'cmux', sessionId: 'supervisor', incarnationId: 'supervisor-inc', cwd: f.root, executable: '/bin/codex' };
  f.adapters.session = {
    observe: async input => input.recipient ? parent : native,
    execute: async input => {
      effects++;
      let result;
      if (input.effect === 'session.deliver') result = { ...parent, task: { ...parent, schema: 'harness.task-receipt/1', effectKey: input.key,
        promptDigest: hash('result'), threadId: 'supervisor-thread', requestId: 'result', turnId: 'turn', activityId: 'read',
        packets: ['result', 'handoff', 'goal'].map(name => ({ path: input.args[`${name}Path`], digest: input.args[`${name}Digest`] })) } };
      else { assert.equal(input.effect, 'session.close'); result = { sessionId: native.sessionId, incarnationId: native.incarnationId, closed: true }; }
      deliveries.set(input.key, result); return result;
    },
    verify: async input => deliveries.has(input.key) ? { status: 'completed', result: deliveries.get(input.key) } : { status: 'unknown' },
  };
  let serial = 0;
  const cli = async (args, request) => {
    if (request) { const file = path.join(f.root, `caller-${++serial}.json`); await writeFile(file, JSON.stringify(request)); args = [...args, args[1] === 'fail' ? '--failure' : '--request', file]; }
    const output = await runUnitCli(args, { cwd: f.root, stateRoot: f.root, adapters: f.adapters });
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  };
  const failed = await cli(['unit', 'fail', 'u'], { class: 'user-domain', failurePoint: 'goal-finish/initial-criteria-binding', reason: 'Original wording cannot bind at finish' });
  assert.equal(failed.code, 3, JSON.stringify(failed));
  assert.equal((await cli(['goal', 'block', 'g'], { expectedRevision: (await f.goals.read('g')).revision, unit: 'u', reason: 'Original binding mismatch', resumeCondition: 'Audited full-obligation clarification', evidence: failed.failureRef.path })).code, 0);
  const packet = ['목표: original goal', '수용 기준: full obligation', '작업관리: original unit', '결정: preserve', '변경: original accepted content', '검증: original evidence', '남은 일·위험: initial binding', '다음 단위 첫 행동: same-owner clarification'].join('\n');
  const resultFields = { title: 'Original binding', objective: 'Retain original obligations', acceptance: 'Full original criterion', tracking: 'Original unit', decision: 'Keep accepted provenance',
    changed: 'Audited binding only', verification: 'Original captured tests and actual outcomes', remainingRisk: 'Publication requires separate authority', nextFirstAction: 'Continue original lifecycle' };
  const parentRuntime = { runtime: native.runtime, sessionId: native.sessionId, incarnationId: native.incarnationId, cwd: native.cwd, workerExecutable: native.executable };
  assert.equal((await cli(['unit', 'session-stop', 'u'], { parentRuntime, handoffContent: packet, resultFields, classification: 'external-input' })).code, 0);
  await f.refresh(); await f.run();
  const record = await f.store.read('u'), goal = await f.goals.read('g'), clarification = record.goalAcceptanceClarifications[0];
  const rows = await createLedgerStore(f.root).withLock('u', ledger => ledger.read());
  const resumeRequest = { id: 'continue-original-1', expectedRevision: goal.revision, unit: 'u', unitDigest: effectArgsDigest(record), goalDigest: effectArgsDigest(goal),
    ledgerDigest: effectArgsDigest(rows), targetDigest: effectArgsDigest(f.target), custodyDigest: effectArgsDigest(goal.bootstraps[0]),
    clarification: { id: clarification.request.id, digest: effectArgsDigest(clarification) }, resolutionEvidence: { ref: f.source.path, digest: f.source.digest }, reason: 'Continue same verified live owner after binding-only recovery' };
  f.adapters.provider.verifyGoalAcceptanceResume = async input => ({ ...input, verified: true, bindingOnly: true });
  const snapshot = path.join(f.root, 'resume-snapshot.json'); await writeFile(snapshot, JSON.stringify({ git: { head: f.target.head, checkpoints: {}, worktreeDiff: [], indexDiff: [] },
    currentFingerprints: Object.fromEntries(record.evidence.map(item => [item.gate, item.fingerprint])) }));
  return { ...f, cli, record, goal, resumeRequest, snapshot, packet, resultFields, parentRuntime, parent, native, effects: () => effects };
}

test('AC-1 AC-2 AC-3 complete public live retained stop -> clarify -> goal/unit resume -> finish preserves original provenance', async t => {
  const f = await retainedCaller(t), failurePath = path.join(f.root, f.goal.goal.blocker.evidence), failureBytes = await readFile(failurePath);
  const activate = () => f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest);
  const resumedGoal = await activate(); assert.equal(resumedGoal.code, 0, JSON.stringify(resumedGoal));
  assert.equal((await activate()).code, 0, 'goal commit replay must be idempotent');
  assert.equal((await f.store.read('u')).state, 'Stopped', 'goal commit cannot implicitly resume the stopped unit'); assert.equal(f.effects(), 0);
  const resumed = await f.cli(['unit', 'resume', 'u', '--snapshot', f.snapshot]); assert.equal(resumed.code, 0, JSON.stringify(resumed)); assert.equal(resumed.state, 'Accepted');
  const record = await f.store.read('u');
  for (const key of ['accepted', 'acceptance', 'evidence', 'reviewDecision', 'reviewedHead', 'verdict', 'policy', 'failures', 'stopReport', 'stages', 'goalAcceptanceClarifications']) assert.deepEqual(record[key], f.record[key], key);
  assert.equal(record.sessionHistory.at(-1).mode, 'retained-clarification'); assert.deepEqual((await f.goals.read('g')).bootstraps, f.goal.bootstraps);
  const finished = await f.cli(['unit', 'finish', 'u'], { parentRuntime: f.parentRuntime, returnTo: f.parent, handoffContent: f.packet, resultFields: f.resultFields,
    goalComplete: true, goalProof: [{ criterion: f.goal.goal.criteria[0], unit: 'u', acceptances: ['AC-1', 'AC-2'] }] });
  assert.equal(finished.code, 3, JSON.stringify(finished)); assert.equal(finished.finalizePending, true);
  const finalized = await f.cli(['unit', 'finalize', 'u']); assert.equal(finalized.code, 0, JSON.stringify(finalized));
  const closed = await f.store.read('u'); assert.equal(closed.state, 'Closed'); assert.equal((await f.goals.read('g')).goal.status, 'complete');
  for (const key of ['accepted', 'acceptance', 'evidence', 'reviewDecision', 'policy', 'failures', 'stopReport', 'goalAcceptanceClarifications']) assert.deepEqual(closed[key], f.record[key], key);
  assert.deepEqual(await readFile(failurePath), failureBytes); assert.equal(f.effects(), 2, 'only result delivery and exact owner close, never a duplicate session');
});

test('AC-2 retained continuation refuses unauthorized, closed, changed, conflicting and stale callers without state loss', async t => {
  const cases = {
    'goal mutation race': { phase: 'unit', prepare: f => { f.adapters.provider.verifyGoalAcceptanceResume = async input => { await assert.rejects(f.goals.transaction('g', g => ({ ...g, revision: g.revision + 1 })), { code: 'GOAL_LOCKED' }); return { ...input, verified: false, bindingOnly: true }; }; } },
    unauthorized: { phase: 'goal', prepare: f => { f.adapters.provider.verifyGoalAcceptanceResume = async input => ({ ...input, verified: false, bindingOnly: true }); } },
    'other blocker': { phase: 'goal', prepare: f => { f.adapters.provider.verifyGoalAcceptanceResume = async input => ({ ...input, verified: true, bindingOnly: false }); } },
    'missing verifier': { phase: 'goal', prepare: f => { delete f.adapters.provider.verifyGoalAcceptanceResume; } },
    'wrong owner': { phase: 'goal', prepare: f => { f.adapters.session.observe = async () => ({ ...f.native, sessionId: 'foreign' }); } },
    'owner closed after goal resume': { phase: 'unit', prepare: f => { f.adapters.session.observe = async () => ({ closed: true, owner: f.native }); } },
    'source changed after goal resume': { phase: 'unit', prepare: f => writeFile(f.source.path, 'foreign source') },
    'stale fingerprints': { phase: 'unit', prepare: async f => { const snapshot = JSON.parse(await readFile(f.snapshot)); snapshot.currentFingerprints.tests = 'stale'; await writeFile(f.snapshot, JSON.stringify(snapshot)); } },
    'goal changed': { phase: 'unit', prepare: f => f.goals.transaction('g', goal => ({ ...goal, revision: goal.revision + 1 })) },
    'conflicting replay': { phase: 'goal-replay', prepare: f => { f.resumeRequest.reason = 'another request'; } },
  };
  for (const [name, scenario] of Object.entries(cases)) await t.test(name, async t => {
    const f = await retainedCaller(t);
    if (scenario.phase !== 'goal') assert.equal((await f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest)).code, 0);
    await scenario.prepare(f);
    const unit = await f.store.read('u'), goal = await f.goals.read('g');
    const result = scenario.phase === 'unit' ? await f.cli(['unit', 'resume', 'u', '--snapshot', f.snapshot])
      : await f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest);
    assert.notEqual(result.code, 0, JSON.stringify(result)); assert.deepEqual(await f.store.read('u'), unit); assert.deepEqual(await f.goals.read('g'), goal); assert.equal(f.effects(), 0);
  });
});

test('AC-2 retained goal continuation recovers process death before and after goal commit without changing unit or owner', async t => {
  for (const phase of ['before', 'after']) await t.test(phase, async t => {
    const f = await retainedCaller(t), file = path.join(f.root, 'live-child.json');
    await writeFile(file, JSON.stringify({ root: f.root, request: f.resumeRequest, target: f.target, native: f.native, phase }));
    const script = `
      import { readFile } from 'node:fs/promises';
      import { createUnitStateStore } from ${JSON.stringify(new URL('./lib/unit-state.mjs', import.meta.url).href)};
      import { resumeRetainedClarificationGoal } from ${JSON.stringify(new URL('./lib/goal-acceptance-resume.mjs', import.meta.url).href)};
      const p = JSON.parse(await readFile(process.argv[1]));
      const hold = async () => { console.log('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      const original = createUnitStateStore(p.root), store = { ...original, withLock: async (...args) => { const value = await original.withLock(...args); if (p.phase === 'after') await hold(); return value; } };
      await resumeRetainedClarificationGoal({ stateRoot: p.root, store, id: 'g', request: p.request, userInputRef: 'original-human',
        adapters: { now: () => '2026-01-01T00:00:00Z', git: { inspectUnit: async () => p.target }, session: { observe: async () => p.native }, provider: {
          verifyUserInput: async input => ({ ...input, verified: true }), verifyGoalAcceptanceClarification: async input => ({ ...input, verified: true }),
          verifyGoalAcceptanceResume: async input => { if (p.phase === 'before') await hold(); return { ...input, verified: true, bindingOnly: true }; } } } });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] }); t.after(() => child.kill());
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(errors || 'child exited before crash boundary'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const replay = await f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest); assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.deepEqual(await f.store.read('u'), f.record);
    const goal = await f.goals.read('g'); assert.equal(goal.retainedClarificationResumptions.length, 1); assert.deepEqual(goal.bootstraps, f.goal.bootstraps);
    assert.equal((await f.cli(['unit', 'resume', 'u', '--snapshot', f.snapshot])).code, 0); assert.equal((await f.store.read('u')).state, 'Accepted'); assert.equal(f.effects(), 0);
  });
});

test('AC-2 clarified finalization reconciles actual exact-owner closure after a lost response without needing a live closed owner', async t => {
  const f = await retainedCaller(t);
  assert.equal((await f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest)).code, 0);
  assert.equal((await f.cli(['unit', 'resume', 'u', '--snapshot', f.snapshot])).code, 0);
  const finished = await f.cli(['unit', 'finish', 'u'], { parentRuntime: f.parentRuntime, returnTo: f.parent, handoffContent: f.packet, resultFields: f.resultFields,
    goalComplete: true, goalProof: [{ criterion: f.goal.goal.criteria[0], unit: 'u', acceptances: ['AC-1', 'AC-2'] }] });
  assert.equal(finished.code, 3);
  let closed = false, lost = true;
  const execute = f.adapters.session.execute, verify = f.adapters.session.verify;
  f.adapters.session.observe = async input => { if (input.recipient) return f.parent; if (closed) throw new Error('exact owner is already closed'); return f.native; };
  f.adapters.session.execute = async input => { const result = await execute(input); if (input.effect === 'session.close') { closed = true; throw new Error('close response lost'); } return result; };
  f.adapters.session.verify = async input => input.effect === 'session.close' && lost ? { status: 'unknown' } : verify(input);
  const pending = await f.cli(['unit', 'finalize', 'u']); assert.equal(pending.code, 3, JSON.stringify(pending)); assert.equal(closed, true);
  assert.equal((await f.store.read('u')).state, 'Delivered');
  lost = false;
  f.adapters.session.verify = async input => input.effect === 'session.close'
    ? { status: 'completed', result: { closed: true, sessionId: 'foreign-owner', incarnationId: f.native.incarnationId } } : verify(input);
  const foreign = await f.cli(['unit', 'finalize', 'u']); assert.notEqual(foreign.code, 0); assert.equal((await f.store.read('u')).state, 'Delivered');
  f.adapters.session.verify = verify;
  const reconciled = await f.cli(['unit', 'finalize', 'u']); assert.equal(reconciled.code, 0, JSON.stringify(reconciled));
  assert.equal((await f.store.read('u')).state, 'Closed'); assert.equal((await f.goals.read('g')).goal.status, 'complete');
  assert.equal(f.effects(), 2, 'the original close is observed, never executed a second time');
});


test('AC-2 native absence without an original close intent cannot complete a clarified unit', async t => {
  const f = await retainedCaller(t);
  assert.equal((await f.cli(['goal', 'resume', 'g', '--user-input', 'original-human'], f.resumeRequest)).code, 0);
  assert.equal((await f.cli(['unit', 'resume', 'u', '--snapshot', f.snapshot])).code, 0);
  assert.equal((await f.cli(['unit', 'finish', 'u'], { parentRuntime: f.parentRuntime, returnTo: f.parent, handoffContent: f.packet, resultFields: f.resultFields,
    goalComplete: true, goalProof: [{ criterion: f.goal.goal.criteria[0], unit: 'u', acceptances: ['AC-1', 'AC-2'] }] })).code, 3);
  f.adapters.session.observe = async input => { if (input.recipient) return f.parent; throw new Error('owner absent without managed close'); };
  const verify = f.adapters.session.verify;
  f.adapters.session.verify = async input => input.effect === 'session.close'
    ? { status: 'completed', result: { closed: true, sessionId: f.native.sessionId, incarnationId: f.native.incarnationId } } : verify(input);
  const result = await f.cli(['unit', 'finalize', 'u']); assert.notEqual(result.code, 0); assert.equal((await f.store.read('u')).state, 'Delivered');
  assert.equal((await f.goals.read('g')).goal.status, 'active'); assert.equal(f.effects(), 1, 'only result delivery, never an invented native close');
});
