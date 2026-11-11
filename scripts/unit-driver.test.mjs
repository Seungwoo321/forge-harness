import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { runUnitCli as runCoreUnitCli } from './lib/unit-driver.mjs';
import { runPolicyCli } from './policy.mjs';
import { createRecoveryStore } from './lib/recovery-store.mjs';
import { createAdapters } from './lib/adapters.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runUnitCli(argv, options) {
  const gateCommand = argv[0] === 'unit' && argv[1] === 'accept' || argv[0] === 'evidence' && argv[1] === 'rerun';
  return runCoreUnitCli(argv, gateCommand && !options.cwd ? { ...options, cwd: path.dirname(options.stateRoot) } : options);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-driver-'));
  await Promise.all(['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage', 'risk-scenarios'].map(id =>
    writeFile(path.join(root, `${id}.mjs`), `source:${id}`)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'work-state');
  const unit = 'unit-a';
  const store = createUnitStateStore(stateRoot);
  await store.create({
    schema: 'harness.unit/1', unit, revision: 0, kind: 'impl', state: 'Scoped',
    request: 'Implement the requested change', canon: [], policy: { goal: { class: 'task' } },
    tracker: null, isolation: 'shared', stages: [], assumptions: [], openDecisions: [],
  });
  const checkpointChanges = new Map();
  const adapters = {
    command: async () => ({ exitCode: 0, stdout: `${root}/.git\n` }),
    now: () => '2026-01-01T00:00:00.000Z',
    id: () => 'failure-1',
    git: { async inspectUnit() { return { head: 'head-1', contentFingerprint: 'sha256:content' }; } },
    checkpoint: {
      async createCheckpoint({ ref }) { return { commit: `commit:${ref}`, worktreeChanged: false, indexChanged: false, excluded: [] }; },
      async inspectChanges({ unit: changedUnit }) { return checkpointChanges.get(changedUnit) ?? { firstCheckpointDiff: [], attemptDiff: [] }; },
    },
  };
  return { root, stateRoot, unit, store, adapters, checkpointChanges };
}

function result(output) {
  const line = output.split('\n').at(-1);
  assert.match(line, /^RESULT /);
  return JSON.parse(line.slice('RESULT '.length));
}

function acceptanceAdapters({ kind = 'impl', coverage = true, pendingGate = null, liveTargets = null } = {}) {
  const gatesRun = [];
  let targetIndex = 0;
  const head = 'head-1';
  const contentFingerprint = 'sha256:content';
  const described = new Map();
  const gates = {
    async describe(id) {
      const gate = { id, command: ['node', 'check', id], files: [{ path: `${id}.mjs`, content: `source:${id}` }], format: id === pendingGate ? 'exec' : 'tap', reportPath: `${id}.tap`, acPattern: 'AC-1', ...(id === pendingGate ? { resultFormat: 'json' } : {}) };
      described.set(id, gate);
      return gate;
    },
    async run(gate) {
      gatesRun.push(gate.id);
      const testName = gate.id === 'risk-scenarios' ? 'risk validation AC-1' : 'covers AC-1';
      const report = coverage ? `TAP version 13\n1..1\nok 1 - ${testName}\n` : 'TAP version 13\n1..1\nok 1 - no coverage\n';
      return { exit: 0, report, reportPath: gate.reportPath, ...(gate.id === pendingGate ? { judge: { status: 'pending' } } : {}) };
    },
  };
  return {
    gatesRun,
    adapters: {
      now: () => '2026-01-01T00:00:00.000Z',
      git: { async inspectUnit() { return liveTargets?.[targetIndex++] ?? { head, contentFingerprint }; } },
      async command(_binary, args) {
        const gate = described.get(args.at(-1));
        const output = await gates.run(gate);
        return { exitCode: output.exit, stdout: gate.resultFormat === 'json'
          ? JSON.stringify({ ok: true, covers: coverage ? ['AC-1'] : [], judge: output.judge }) : output.report };
      },
      gates,
    },
  };
}

async function prepareAcceptanceRecord(store, unit, { kind = 'impl', review = { mode: 'none', by: 'session', triggers: [] }, riskAssessment = null } = {}) {
  await store.update(unit, current => ({
    ...current, state: 'SelfGated', kind, head: 'head-1', contentFingerprint: 'sha256:content',
    acceptance: [{ id: 'AC-1', text: 'The gate validates the requested behavior', status: 'open' }],
    evidence: [], reviewDecision: null, reviewedHead: null, verdict: null, findings: [],
    changedPaths: [], diff: {}, handoff: {}, assumptions: [], riskAssessment,
    policy: { goal: { class: 'task' }, review },
  }));
}

async function prepareReviewTarget(store, unit, by = 'session') {
  await prepareAcceptanceRecord(store, unit, { review: { mode: 'required', by, triggers: [] } });
  await store.transition(unit, 'InReview');
  await store.update(unit, current => ({ ...current, reviewDecision: { required: true, by } }));
}

async function createReviewUnit(store, unit, targetUnit, by = 'session') {
  await store.create({
    schema: 'harness.unit/1', unit, revision: 0, kind: 'review', state: 'InReview', targetUnit,
    request: { text: `Review ${targetUnit}`, userInputRef: 'input:review' },
    policy: { goal: { class: 'task' }, review: { mode: 'required', by, triggers: [] } },
    policySources: { 'goal.class': 'project', 'review.by': 'project' },
    tracker: null, isolation: 'worktree', canon: [], scopePaths: [], acceptance: [], stages: [],
    changedPaths: [], diff: {}, handoff: {}, feedback: [], evidence: [], findings: [], failures: [],
    assumptions: [], openDecisions: [], coverage: [], riskAssessment: null, verdict: null,
    reviewedHead: null, reviewDecision: null, accepted: null,
  });
}

test('stage open writes schema-bound input under canonical unit storage and selects its profile', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  const output = await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], {
    stateRoot, contractsDir: path.join(repo, 'skills'), adapters,
  });
  const cli = result(output);
  assert.equal(cli.code, 0);
  assert.equal(cli.profile, 'impl');
  assert.equal(cli.attempt, 1);
  assert.equal(cli.input, path.join(stateRoot, 'units', unit, 'stages', 'scope.1.input.json'));
  const input = JSON.parse(await readFile(cli.input, 'utf8'));
  assert.equal(input.stage, 'scope');
  assert.equal(input.unit, unit);
  assert.equal(input.inputDigest.startsWith('sha256:'), true);
  assert.equal((await store.read(unit)).stages[0].attempts[0].inputDigest, input.inputDigest);
  assert.equal((await store.read(unit)).stages[0].attempts[0].checkpoint, 'refs/harness/unit-a/scope.1');
});

test('unit progress uses the fixed acceptance list and only current successful coverage', async t => {
  const { stateRoot, root, unit, store, adapters } = await fixture(t);
  const acceptance = [
    { id: 'AC-1', status: 'open' },
    { id: 'AC-2', status: 'open' },
    { id: 'AC-3', status: 'deferred' },
    { id: 'AC-4', status: 'dropped' },
  ];
  await store.update(unit, current => ({
    ...current,
    state: 'SelfGated', acceptance, scopePaths: ['src/**'], feedback: [],
    evidence: [
      { gate: 'tests', exit: 0, status: 'passed', covers: ['AC-1'] },
      { gate: 'lint', exit: 1, status: 'failed', covers: ['AC-2'] },
    ],
  }));
  const options = { stateRoot, adapters, contractsDir: path.join(repo, 'skills') };
  const before = result(await runUnitCli(['unit', 'progress', unit], options));
  assert.deepEqual(before.progress, { total: 4, active: 2, covered: 1, uncovered: 1, deferred: 1, dropped: 1, percent: 50 });

  await store.transition(unit, 'Implementing');
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'implement'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(root, 'implement-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'changed-criteria', status: 'done', summary: 'Try to replace criteria',
    changedPaths: [], coverage: [], assumptions: [], openDecisions: [], acceptance: [{ id: 'AC-99', status: 'open' }],
  }));
  const rejected = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'implement', '--output', outputPath], options));
  assert.equal(rejected.code, 2);
  assert.deepEqual((await store.read(unit)).acceptance, acceptance);
  const after = result(await runUnitCli(['unit', 'progress', unit], options));
  assert.deepEqual(after.progress, before.progress);
});

test('scope submission records reasoned assumptions without creating user questions', async t => {
  const { stateRoot, root, unit, store, adapters } = await fixture(t);
  const options = { stateRoot, adapters, contractsDir: path.join(repo, 'skills') };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(root, 'scope-output.json');
  const assumption = { decision: 'Use the existing module boundary', basis: 'The request and current code define one compatible integration path.', reversible: true };
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'scope-1', status: 'done', summary: 'Scope is fixed',
    acceptance: [{ id: 'AC-1', text: 'The existing integration path is used.' }], scopePaths: ['scripts/lib/**'],
    assumptions: [assumption], openDecisions: [],
  }));
  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  assert.equal(submitted.state, 'Implementing');
  assert.deepEqual((await store.read(unit)).assumptions, [assumption]);
  assert.deepEqual((await store.read(unit)).openDecisions, []);
});

test('unit start stops on POLICY_UNSET, then replays the same request after policy confirmation', async t => {
  const { root, stateRoot, unit, store, adapters } = await fixture(t);
  const startedUnit = `${unit}-start`;
  const requestPath = path.join(root, 'unit-request.json');
  await writeFile(requestPath, JSON.stringify({ kind: 'impl', request: { text: 'Implement the requested behavior', userInputRef: 'input:1' }, canon: [] }));
  const args = ['unit', 'start', startedUnit, '--request', requestPath];
  const blocked = result(await runUnitCli(args, { cwd: root, stateRoot, adapters }));
  assert.equal(blocked.code, 3);
  assert.equal(blocked.error, 'POLICY_UNSET');
  assert.equal(await store.read(startedUnit), null);

  const draftPath = path.join(root, 'policy-draft.json');
  await writeFile(draftPath, JSON.stringify({ goal: { class: 'task' } }));
  const confirmed = result(await runPolicyCli([
    'policy', 'set', '--level', 'project', '--draft', draftPath,
    '--state-root', stateRoot, '--project-root', root,
  ], { cwd: root, adapters }));
  assert.equal(confirmed.code, 0);

  const started = result(await runUnitCli(args, { cwd: root, stateRoot, adapters }));
  const record = await store.read(startedUnit);
  assert.equal(started.code, 0);
  assert.equal(started.state, 'Scoped');
  assert.equal(record.state, 'Scoped');
  assert.deepEqual(record.goal, { class: 'task', source: 'project' });
  assert.equal(record.request.userInputRef, 'input:1');
  const resumed = result(await runUnitCli(args, { cwd: root, stateRoot, adapters }));
  assert.equal(resumed.resumed, true);
  assert.equal((await store.read(startedUnit)).revision, record.revision);
  const scoped = result(await runUnitCli(['unit', 'stage', 'open', startedUnit, 'scope'], {
    cwd: root, stateRoot, contractsDir: path.join(repo, 'skills'), adapters,
  }));
  assert.equal(scoped.code, 0);
  assert.equal(JSON.parse(await readFile(scoped.input, 'utf8')).stage, 'scope');
});

test('non-interactive unit start uses the conservative unconfirmed task default', async t => {
  const { root, stateRoot, unit, store, adapters } = await fixture(t);
  const startedUnit = `${unit}-start`;
  const requestPath = path.join(root, 'unit-request.json');
  await writeFile(requestPath, JSON.stringify({ kind: 'impl', request: { text: 'Implement the requested behavior', userInputRef: 'input:2' } }));
  const started = result(await runUnitCli(['unit', 'start', startedUnit, '--request', requestPath, '--non-interactive'], { cwd: root, stateRoot, adapters }));
  assert.equal(started.code, 0);
  assert.deepEqual((await store.read(startedUnit)).goal, { class: 'task', source: 'unconfirmed-default' });
});

test('stage submit validates and records output then applies the lifecycle transition', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'scope-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'submission-1',
    status: 'done', summary: 'Scope confirmed', acceptance: [{ id: 'AC-1', text: 'The unit uses its documented profile' }], scopePaths: ['scripts/**'],
  }));
  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  assert.equal(submitted.code, 0);
  assert.equal(submitted.state, 'Implementing');
  const record = await store.read(unit);
  assert.equal(record.state, 'Implementing');
  assert.deepEqual(record.acceptance.map(item => item.id), ['AC-1']);
  assert.equal(record.stages[0].attempts[0].submissionId, 'submission-1');
});

test('stage submit records Git-derived attempt and unit paths and creates a scope finding without restoring files', async t => {
  const { stateRoot, unit, store, adapters, checkpointChanges } = await fixture(t);
  checkpointChanges.set(unit, { firstCheckpointDiff: ['src/a.mjs', 'docs/spec.md'], attemptDiff: ['src/a.mjs', 'docs/spec.md'] });
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'scope-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'scope-paths', status: 'done', summary: 'Scope recorded',
    acceptance: [{ id: 'AC-1', text: 'Keep changes in scope' }], scopePaths: ['src/**'],
  }));
  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  const record = await store.read(unit);
  assert.equal(submitted.code, 0);
  assert.deepEqual(record.stages[0].attempts[0].changedPaths, ['docs/spec.md', 'src/a.mjs']);
  assert.deepEqual(record.changedPaths, ['docs/spec.md', 'src/a.mjs']);
  assert.deepEqual(record.findings.at(-1), { kind: 'scope-guard', severity: 'must-fix', paths: ['docs/spec.md'], resolvedAt: null });
});

test('shared path overlap is not attributed and is persisted for both active units', async t => {
  const { stateRoot, unit, store, adapters, checkpointChanges } = await fixture(t);
  const otherStore = createUnitStateStore(stateRoot);
  await otherStore.create({
    schema: 'harness.unit/1', unit: 'unit-b', revision: 0, kind: 'impl', state: 'Implementing',
    request: 'Another active unit', canon: [], policy: { goal: { class: 'task' } }, isolation: 'shared',
    tracker: null, changedPaths: [], stages: [{ name: 'implement', attempts: [{ n: 1, checkpoint: 'refs/harness/unit-b/implement.1', startedAt: 'now', endedAt: null }] }],
    assumptions: [], openDecisions: [],
  });
  checkpointChanges.set(unit, { firstCheckpointDiff: ['src/shared.mjs'], attemptDiff: ['src/shared.mjs'] });
  checkpointChanges.set('unit-b', { firstCheckpointDiff: ['src/shared.mjs'], attemptDiff: ['src/shared.mjs'] });
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'shared-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'shared-path', status: 'done', summary: 'Scope recorded',
    acceptance: [{ id: 'AC-1', text: 'Keep changes in scope' }], scopePaths: ['src/**'],
  }));
  await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options);
  const finding = { kind: 'shared-path', severity: 'must-fix', units: ['unit-a', 'unit-b'], paths: ['src/shared.mjs'] };
  assert.deepEqual((await store.read(unit)).changedPaths, []);
  assert.ok((await store.read(unit)).findings.some(item => JSON.stringify(item) === JSON.stringify(finding)));
  assert.ok((await otherStore.read('unit-b')).findings.some(item => JSON.stringify(item) === JSON.stringify(finding)));
});

test('contract violations return CLI code 2 and include the violated paths', async t => {
  const { stateRoot, unit, adapters } = await fixture(t);
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'invalid-output.json');
  await writeFile(outputPath, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'bad', status: 'done' }));
  const rejected = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  assert.equal(rejected.code, 2);
  assert.equal(rejected.error, 'STAGE_CONTRACT_INVALID');
  assert.ok(rejected.issues.some(issue => issue.path === '$.acceptance'));
});

test('profile selection follows the documented kind plans and rejects unsupported kinds', async () => {
  const { selectProfile } = await import('./lib/profile.mjs');
  assert.deepEqual(selectProfile('ops').states, ['Scoped', 'Closed', 'Blocked', 'Stopped']);
  assert.ok(selectProfile('impl-risk').gates.includes('risk-scenarios'));
  assert.throws(() => selectProfile('unknown'), { code: 'PROFILE_UNSUPPORTED' });
});

test('effect CLI uses the policy and ledger modules with an injected authority and execution adapter', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  await store.update(unit, record => ({ ...record, policy: { ...record.policy, delivery: 'commit' } }));
  await store.transition(unit, 'Implementing');
  const argsPath = path.join(stateRoot, 'effect-args.json');
  await writeFile(argsPath, JSON.stringify({ repo: 'repo-a', branch: 'work', tree: 'tree-a', parent: 'parent-a' }));
  const calls = [];
  const output = await runUnitCli(['unit', 'effect', unit, '--effect', 'git.commit', '--args', argsPath], {
    stateRoot,
    adapters: {
      ...adapters,
      effectContext: async () => ({ resourceOwned: true, productOwned: false, inScope: true, operational: false,
        irreversible: false, containsSecret: false, forbiddenCommand: false }),
      effect: {
        async execute(request) { calls.push(request); return { commit: 'commit-a' }; },
        async verify() { return { status: 'unknown' }; },
      },
    },
  });
  const cli = result(output);
  assert.equal(cli.code, 0);
  assert.equal(cli.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal((await readFile(path.join(stateRoot, 'units', unit, 'ledger.ndjson'), 'utf8')).includes('"event":"intent"'), true);
});

test('stage open rejects a profile stage when the Unit Record is in the wrong state', async t => {
  const { stateRoot, unit, adapters } = await fixture(t);
  const output = await runUnitCli(['unit', 'stage', 'open', unit, 'implement'], {
    stateRoot, contractsDir: path.join(repo, 'skills'), adapters,
  });
  assert.equal(result(output).code, 1);
  assert.equal(result(output).error, 'INVALID_TRANSITION');
});

test('unit decision commands notify once, defer blocked criteria, and resume after an answer', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  await store.update(unit, current => ({
    ...current, state: 'Implementing',
    tracker: { adapter: 'stub', ref: 'decision-tracker', projected: false },
    canon: [{ path: 'docs/spec.md', digest: 'sha256:canon' }],
    acceptance: [{ id: 'AC-1', text: 'Decide the preference', status: 'open' }],
    openDecisions: [{ id: 'D-1', kind: 'preference', question: 'Choose one', options: ['A', 'B'], blocks: ['AC-1'], requiredAction: null, canonRefs: ['docs/spec.md'], notifiedAt: null, answer: null }],
    policy: { goal: { class: 'task' }, escalation: { canonReviewAt: 2 } },
  }));
  const projections = [];
  const options = { stateRoot, adapters: { ...adapters, tracker: { async read() { return null; }, async project(ref, value) { projections.push({ ref, value }); } } } };
  const notified = result(await runUnitCli(['unit', 'decision', 'notify', unit, '--decision-id', 'D-1'], options));
  assert.equal(notified.code, 0);
  assert.equal((await store.read(unit)).state, 'Stopped');
  assert.equal(projections[0].value.state, 'Stopped');
  assert.equal((await store.read(unit)).acceptance[0].status, 'deferred');
  const resolved = result(await runUnitCli(['unit', 'decision', 'resolve', unit, '--decision-id', 'D-1', '--answer', 'A'], options));
  assert.equal(resolved.code, 0);
  assert.equal((await store.read(unit)).state, 'Implementing');
  assert.equal((await store.read(unit)).acceptance[0].status, 'open');
  assert.equal(projections[1].value.state, 'Implementing');
});

test('scope stage submission records a decision notification without trusting control-plane fields from the stage output', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  await store.update(unit, current => ({ ...current, canon: [{ path: 'docs/spec.md', digest: 'sha256:canon' }], policy: { goal: { class: 'task' }, escalation: { canonReviewAt: 1 } } }));
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'scope-decision.json');
  const scopeOutput = {
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'decision-submit', status: 'done', summary: 'Decision needed',
    acceptance: [{ id: 'AC-1', text: 'Confirm one preference' }], scopePaths: ['scripts/**'],
    openDecisions: [{ id: 'D-1', kind: 'preference', question: 'Choose one', options: ['A', 'B'], blocks: ['AC-1'], requiredAction: null, canonRefs: ['docs/spec.md'] }],
  };
  await writeFile(outputPath, JSON.stringify({ ...scopeOutput, openDecisions: [{ ...scopeOutput.openDecisions[0], notifiedAt: 'forged', answer: 'forged' }] }));
  const forged = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  assert.equal(forged.code, 2);
  assert.equal((await store.read(unit)).openDecisions.length, 0);
  await writeFile(outputPath, JSON.stringify({ ...scopeOutput, submissionId: 'decision-submit-valid' }));
  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  const record = await store.read(unit);
  assert.equal(submitted.code, 3);
  assert.equal(submitted.notifications[0].decisionId, 'D-1');
  assert.equal(submitted.escalations.length, 1);
  assert.equal(record.state, 'Stopped');
  assert.equal(record.openDecisions[0].notifiedAt, adapters.now());
  assert.equal(record.openDecisions[0].answer, null);
  assert.equal(record.acceptance[0].status, 'deferred');
});

test('needs-decision keeps the stage attempt open until the decision is answered and the stage is resubmitted', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  await store.update(unit, current => ({
    ...current, canon: [{ path: 'docs/spec.md', digest: 'sha256:canon' }],
    policy: { goal: { class: 'task' }, escalation: { canonReviewAt: 5 } },
  }));
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'scope'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'needs-decision.json');
  const decision = { id: 'D-1', kind: 'preference', question: 'Choose a behavior', options: ['A', 'B'], blocks: [], requiredAction: null, canonRefs: ['docs/spec.md'] };
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'needs-decision', status: 'needs-decision', summary: 'Need one choice',
    acceptance: [{ id: 'AC-1', text: 'Use the chosen behavior' }], scopePaths: ['scripts/**'], openDecisions: [decision],
  }));
  const pending = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  let record = await store.read(unit);
  assert.equal(pending.code, 3);
  assert.equal(pending.status, 'needs-decision');
  assert.equal(pending.stageFinished, false);
  assert.match(pending.summary, /Decision required/);
  assert.equal(record.state, 'Blocked');
  assert.equal(record.stages[0].attempts[0].endedAt, null);

  const resolved = result(await runUnitCli(['unit', 'decision', 'resolve', unit, '--decision-id', 'D-1', '--answer', 'A'], { stateRoot, adapters }));
  assert.equal(resolved.state, 'Scoped');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'decision-complete', status: 'done', summary: 'Scope confirmed',
    acceptance: [{ id: 'AC-1', text: 'Use the chosen behavior' }], scopePaths: ['scripts/**'],
  }));
  const completed = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'scope', '--output', outputPath], options));
  record = await store.read(unit);
  assert.equal(completed.code, 0);
  assert.equal(record.state, 'Implementing');
  assert.ok(record.stages[0].attempts[0].endedAt);
});

test('unknown failure classification is persisted by root-cause before retry can be reserved', async t => {
  const { stateRoot, root, unit, store, adapters } = await fixture(t);
  await store.transition(unit, 'Implementing');
  const failureSnapshot = {
    evidence: [{ gate: 'tests', status: 'failed', fingerprint: 'sha256:before' }],
    changedPaths: ['src/changed-before-failure.mjs'],
    diff: { summary: 'failure-time diff' },
  };
  await store.update(unit, current => ({ ...current, ...failureSnapshot }));
  const failurePath = path.join(root, 'unknown-failure.json');
  await writeFile(failurePath, JSON.stringify({ failurePoint: 'test:7', reason: 'unexpected result' }));
  const failed = result(await runUnitCli(['unit', 'fail', unit, '--failure', failurePath], { stateRoot, adapters }));
  assert.equal(failed.action, 'diagnose');
  const denied = result(await runUnitCli(['unit', 'retry', unit, '--cause-key', failed.causeKey], { stateRoot, adapters }));
  assert.equal(denied.error, 'DIAGNOSIS_REQUIRED');
  await store.update(unit, current => ({ ...current, evidence: [], changedPaths: [], diff: {} }));

  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'root-cause'], options));
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  assert.deepEqual(input.data.evidence, failureSnapshot.evidence);
  assert.deepEqual(input.data.changedPaths, failureSnapshot.changedPaths);
  assert.deepEqual(input.data.diff, failureSnapshot.diff);
  assert.equal(input.data.failures[0].failurePoint, 'test:7');
  assert.deepEqual(input.data.failures[0].snapshot, failureSnapshot);
  const diagnosisPath = path.join(stateRoot, 'diagnosis-output.json');
  await writeFile(diagnosisPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'confirmed-class', status: 'done', summary: 'Failure is in the product behavior',
    findings: [{ id: 'D-1', kind: 'diagnosis', severity: 'must-fix', site: 'test:7', claim: 'The output violates the acceptance behavior', case: 'Unexpected result', fix: 'Correct the implementation', classification: 'product' }],
    assumptions: [],
  }));
  const diagnosed = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'root-cause', '--output', diagnosisPath], options));
  assert.equal(diagnosed.code, 0);
  assert.equal(diagnosed.diagnosis.class, 'product');
  assert.equal((await store.read(unit)).findings.at(-1).classification, 'product');
  const retry = result(await runUnitCli(['unit', 'retry', unit, '--cause-key', failed.causeKey], { stateRoot, adapters }));
  assert.equal(retry.action, 'retry');
});

test('completed harness resolver persists release and resumes the blocked stage without a terminal result', async t => {
  const { stateRoot, root, unit, store, adapters } = await fixture(t);
  await store.update(unit, current => ({ ...current, state: 'Implementing', evidence: [], changedPaths: [], diff: {} }));
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const failurePath = path.join(root, 'harness-failure.json');
  await writeFile(failurePath, JSON.stringify({ class: 'harness', failurePoint: 'runner:submit', reason: 'invalid stage contract' }));
  const failed = result(await runUnitCli(['unit', 'fail', unit, '--failure', failurePath], options));
  assert.equal(failed.action, 'resolver');
  assert.equal(failed.state, 'Blocked');
  assert.equal((await store.read(unit)).blockedFrom, 'Implementing');
  await assert.rejects(readFile(path.join(stateRoot, 'handoff', `${unit}-result.md`)), { code: 'ENOENT' });

  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'root-cause'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(root, 'resolver-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'resolver-complete', status: 'done', summary: 'Harness issue resolved',
    findings: [], assumptions: [],
  }));
  const completed = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'root-cause', '--output', outputPath], options));
  assert.deepEqual(completed.resolver, { causeKey: failed.causeKey, active: false });

  const freshRecovery = createRecoveryStore(stateRoot);
  assert.equal((await freshRecovery.causes())[failed.causeKey].activeResolver, false);
  assert.equal((await freshRecovery.causes())[failed.causeKey].lastAction, 'resolver-completed');
  const checkpoint = 'refs/harness/unit-a/root-cause.1';
  const snapshotPath = path.join(root, 'resume-after-resolver.json');
  await writeFile(snapshotPath, JSON.stringify({
    git: { head: 'head-1', contentFingerprint: 'sha256:current', checkpoints: { [checkpoint]: 'checkpoint-1' }, worktreeDiff: [], indexDiff: [] },
    evidence: [], currentFingerprints: {},
  }));
  const resumed = result(await runUnitCli(['unit', 'resume', unit, '--snapshot', snapshotPath], options));
  assert.equal(resumed.stage, 'implement');
  assert.equal((await store.read(unit)).state, 'Implementing');
  assert.equal((await store.read(unit)).blockedFrom, null);
  await assert.rejects(readFile(path.join(stateRoot, 'handoff', `${unit}-result.md`)), { code: 'ENOENT' });
});

test('session-boundary resume leaves the active Unit Record and all recovery counters unchanged', async t => {
  const { stateRoot, root, unit, store, adapters } = await fixture(t);
  const beforeRecord = await store.read(unit);
  const beforeCauses = await createRecoveryStore(stateRoot).causes();
  const snapshotPath = path.join(root, 'session-boundary.json');
  await writeFile(snapshotPath, JSON.stringify({
    event: { kind: 'session-boundary', cause: 'context-compressed' },
    git: { head: 'head-1', checkpoints: {}, worktreeDiff: [], indexDiff: [] },
    evidence: [], currentFingerprints: {},
  }));
  const resumed = result(await runUnitCli(['unit', 'resume', unit, '--snapshot', snapshotPath], { stateRoot, adapters }));
  assert.equal(resumed.code, 0);
  assert.equal(resumed.event.kind, 'session-boundary');
  assert.equal(resumed.event.cause, 'context-compressed');
  assert.equal(resumed.stage, 'scope');
  assert.deepEqual(await store.read(unit), beforeRecord);
  const afterCauses = await createRecoveryStore(stateRoot).causes();
  assert.deepEqual(afterCauses, beforeCauses);
  assert.equal(Object.values(afterCauses).some(cause => cause.retries > 0 || cause.resolverAttempts > 0 || cause.activeResolver), false);
});

test('unit accept runs profile gates, persists evidence, and accepts only the current covered target', async t => {
  const { stateRoot, unit, store } = await fixture(t);
  await prepareAcceptanceRecord(store, unit);
  const { adapters, gatesRun } = acceptanceAdapters();
  const accepted = result(await runUnitCli(['unit', 'accept', unit], { stateRoot, adapters }));
  const record = await store.read(unit);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.state, 'Accepted', JSON.stringify(accepted));
  assert.equal(record.accepted.head, 'head-1');
  assert.equal(record.accepted.contentFingerprint, 'sha256:content');
  assert.equal(record.evidence.length, 5);
  assert.equal(gatesRun.length, 5);
});

test('unit accept rejects pending judgments and incomplete acceptance coverage', async t => {
  const pendingFixture = await fixture(t);
  await prepareAcceptanceRecord(pendingFixture.store, pendingFixture.unit);
  const pendingAdapters = acceptanceAdapters({ pendingGate: 'tests' }).adapters;
  const pending = result(await runUnitCli(['unit', 'accept', pendingFixture.unit], { stateRoot: pendingFixture.stateRoot, adapters: pendingAdapters }));
  assert.equal(pending.code, 3);
  assert.equal(pending.error, undefined);
  assert.equal((await pendingFixture.store.read(pendingFixture.unit)).state, 'SelfGated');

  const coverageFixture = await fixture(t);
  await prepareAcceptanceRecord(coverageFixture.store, coverageFixture.unit);
  const coverageAdapters = acceptanceAdapters({ coverage: false }).adapters;
  const uncovered = result(await runUnitCli(['unit', 'accept', coverageFixture.unit], { stateRoot: coverageFixture.stateRoot, adapters: coverageAdapters }));
  assert.equal(uncovered.code, 1);
  assert.match(uncovered.summary, /uncovered/);
  assert.equal((await coverageFixture.store.read(coverageFixture.unit)).state, 'SelfGated');
});

test('required review is recorded before InReview and accepted only after a matching ship submission', async t => {
  const { stateRoot, unit, store, adapters: baseAdapters } = await fixture(t);
  await prepareAcceptanceRecord(store, unit, { review: { mode: 'required', by: 'session', triggers: [] } });
  const { adapters } = acceptanceAdapters();
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters: { ...baseAdapters, ...adapters } };
  const reviewRequired = result(await runUnitCli(['unit', 'accept', unit], options));
  assert.equal(reviewRequired.code, 20);
  assert.equal((await store.read(unit)).state, 'InReview');
  assert.equal((await store.read(unit)).reviewDecision.required, true);

  const opened = result(await runUnitCli(['unit', 'stage', 'open', unit, 'review'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stateRoot, 'review-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'ship-review', status: 'done', summary: 'Reviewed current target',
    findings: [], verdict: 'ship', reviewedHead: 'head-1',
  }));
  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', unit, 'review', '--output', outputPath], options));
  assert.equal(submitted.state, 'Accepted');
  const accepted = result(await runUnitCli(['unit', 'accept', unit], options));
  assert.equal(accepted.code, 0);
  assert.equal(accepted.state, 'Accepted');
  assert.equal((await store.read(unit)).accepted.basis, 'review');
});

test('unavailable project checks require a real review before public acceptance', async t => {
  const {root,stateRoot,unit,store,adapters}=await fixture(t);
  await writeFile(path.join(root,'package.json'),'{"scripts":{"test":"node test"}}');
  await prepareAcceptanceRecord(store,unit,{review:{mode:'conditional',by:'session',triggers:[]}});
  const gateAdapters=acceptanceAdapters().adapters;
  const describe=gateAdapters.gates.describe, run=gateAdapters.gates.run;
  gateAdapters.gates.describe=async id => ['typecheck','build'].includes(id)
    ? {id,command:['inspect-script',id],files:[{path:'package.json',content:'{"scripts":{"test":"node test"}}'}],format:'exec',reportPath:`${id}.txt`,applicability:{state:'not-applicable',reason:`No ${id} script`,evidencePath:'package.json'}}
    : describe(id);
  gateAdapters.gates.run=async gate => { if (gate.applicability) throw new Error('applicability must be derived by the control plane'); return run(gate); };
  const first=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters:gateAdapters}));
  assert.equal(first.code,20,JSON.stringify(first));
  const record=await store.read(unit);
  assert.equal(record.state,'InReview');
  assert.deepEqual(record.evidence.filter(item=>item.status==='not-applicable').map(item=>item.gate),['typecheck','build']);
  assert.ok(record.evidence.filter(item=>item.status==='not-applicable').every(item=>item.covers.length===0));
  const rerun=result(await runUnitCli(['evidence','rerun',unit,'--gate','typecheck'],{cwd:root,stateRoot,adapters:gateAdapters}));
  assert.equal(rerun.code,0,JSON.stringify(rerun));
  assert.equal(rerun.record.status,'not-applicable');
  await createReviewUnit(store,'review-unit',unit);
  const options={stateRoot,contractsDir:path.join(repo,'skills'),adapters};
  const opened=result(await runUnitCli(['unit','stage','open','review-unit','review'],options));
  const input=JSON.parse(await readFile(opened.input,'utf8'));
  const output=path.join(stateRoot,'review-na.json');
  await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'review-na',status:'done',summary:'Reviewed',findings:[],verdict:'ship',reviewedHead:input.head}));
  assert.equal(result(await runUnitCli(['unit','stage','submit','review-unit','review','--output',output],options)).code,0);
  const accepted=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters:gateAdapters}));
  assert.equal(accepted.state,'Accepted',JSON.stringify(accepted));
  assert.equal((await store.read(unit)).accepted.basis,'review');
});

test('authorized active review policy change resolves unavailable checks through public acceptance', async t => {
  const {root,stateRoot,unit,store,adapters:base}=await fixture(t);
  const packageContent='{"scripts":{"test":"node test"}}';await writeFile(path.join(root,'package.json'),packageContent);
  const script='console.log("TAP version 13\\n1..1\\nok 1 - AC-1 isolated")';await writeFile(path.join(root,'gate.mjs'),script);
  await prepareAcceptanceRecord(store,unit,{review:{mode:'none',by:'session',triggers:[]}});
  const gates={async describe(id){return id==='build' ? {id,command:['inspect-script',id],files:[{path:'package.json',content:packageContent}],format:'exec',reportPath:'build.txt',applicability:{state:'not-applicable',reason:'No build script',evidencePath:'package.json'}} : {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:script}],format:'tap',acPattern:'AC-1',reportPath:'gate.tap'};}};
  const adapters={...base,gates,command:createAdapters().command,provider:{async verifyUserInput(input){return {...input,verified:true};}}},options={cwd:root,stateRoot,adapters};
  const first=result(await runUnitCli(['unit','accept',unit],options));assert.notEqual(first.code,0);
  const before=await store.read(unit), request=path.join(root,'review-policy.json');
  await writeFile(request,JSON.stringify({id:'review-change',expectedRevision:before.revision,review:{mode:'required',by:'session',triggers:[]},reason:'User authorized review'}));
  assert.equal(result(await runUnitCli(['unit','policy','change',unit,'--request',request,'--user-input','user'],options)).code,0);
  const pending=result(await runUnitCli(['unit','accept',unit],options));assert.equal(pending.code,20,JSON.stringify(pending));
  await createReviewUnit(store,'review-unit',unit);
  const reviewOptions={...options,contractsDir:path.join(repo,'skills')};
  const opened=result(await runUnitCli(['unit','stage','open','review-unit','review'],reviewOptions));
  const input=JSON.parse(await readFile(opened.input,'utf8')),output=path.join(root,'review-output.json');
  await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'review-policy',status:'done',summary:'Reviewed',findings:[],verdict:'ship',reviewedHead:input.head}));
  assert.equal(result(await runUnitCli(['unit','stage','submit','review-unit','review','--output',output],reviewOptions)).code,0);
  assert.equal(result(await runUnitCli(['unit','accept',unit],options)).state,'Accepted');
});

test('applicability rejects forged project configuration and an incompatible no-review policy', async t => {
  const {root,stateRoot,unit,store}=await fixture(t);
  await writeFile(path.join(root,'package.json'),'{"scripts":{"build":"node build"}}');
  await prepareAcceptanceRecord(store,unit,{review:{mode:'none',by:'session',triggers:[]}});
  const adapters=acceptanceAdapters().adapters, describe=adapters.gates.describe;
  adapters.gates.describe=async id => id==='build'
    ? {id,command:['inspect-script',id],files:[{path:'package.json',content:'{"scripts":{}}'}],format:'exec',reportPath:'build.txt',applicability:{state:'not-applicable',reason:'No build script',evidencePath:'package.json'}}
    : describe(id);
  let response=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters}));
  assert.equal(response.error,'ADAPTER_INVALID');
  await writeFile(path.join(root,'package.json'),'{"scripts":{}}');
  adapters.gates.run=async gate => gate.applicability ? {exit:0,ok:true,report:'Script absent',reportPath:gate.reportPath,covers:[]} : {exit:0,report:'TAP version 13\n1..1\nok 1 - AC-1\n',reportPath:gate.reportPath};
  response=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters}));
  assert.equal(response.code,1); assert.match(response.summary,/configure the missing check or explicitly change the review policy/);
  assert.equal((await store.read(unit)).state,'SelfGated');
});

test('gate inputs changed during execution cannot leave passing evidence', async t => {
  const {root,stateRoot,unit,store}=await fixture(t);
  await prepareAcceptanceRecord(store,unit);
  const adapters=acceptanceAdapters().adapters, describe=adapters.gates.describe, run=adapters.gates.run;
  let changed=false;
  adapters.gates.describe=async id => { const gate=await describe(id); if(id==='tests' && changed) gate.files[0].content='modified'; return gate; };
  adapters.gates.run=async gate => { const output=await run(gate); if(gate.id==='tests') changed=true; return output; };
  const response=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters}));
  assert.equal(response.error,'EVIDENCE_STALE');
  assert.notEqual((await store.read(unit)).evidence.find(item=>item.gate==='tests').status,'passed');
});

test('acceptance rejects a gate whose inputs change at the final transaction', async t => {
  const {root,stateRoot,unit,store}=await fixture(t);
  await prepareAcceptanceRecord(store,unit);
  const adapters=acceptanceAdapters().adapters, describe=adapters.gates.describe;
  let testsObservations=0;
  adapters.gates.describe=async id => { const gate=await describe(id); if(id==='tests' && ++testsObservations>=4) gate.files[0].content='modified'; return gate; };
  const response=result(await runUnitCli(['unit','accept',unit],{cwd:root,stateRoot,adapters}));
  assert.notEqual(response.code,0); assert.notEqual((await store.read(unit)).state,'Accepted');
});

test('review-kind submissions validate against and write verdict/findings to the target, with the user route and acceptance path', async t => {
  const { stateRoot, unit, store, adapters } = await fixture(t);
  const reviewer = 'review-unit';
  await prepareReviewTarget(store, unit, 'user');
  await createReviewUnit(store, reviewer, unit, 'user');
  const options = { stateRoot, contractsDir: path.join(repo, 'skills'), adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', reviewer, 'review'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  assert.equal(input.targetUnit, unit);
  assert.equal(input.head, 'head-1');
  assert.deepEqual(input.data.acceptance.map(item => item.id), ['AC-1']);
  const outputPath = path.join(stateRoot, 'review-target-output.json');
  await writeFile(outputPath, JSON.stringify({
    inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'user-review-1', status: 'done', summary: 'Reviewed target',
    findings: [{ id: 'F-1', kind: 'review', severity: 'should-fix', site: 'scripts/unit.mjs:1', claim: 'Could simplify', case: 'Maintenance', fix: 'Consider extracting the command' }],
    verdict: 'ship', reviewedHead: input.head,
  }));
  const unauthorized = result(await runUnitCli(['unit', 'stage', 'submit', reviewer, 'review', '--output', outputPath], options));
  assert.equal(unauthorized.code, 2);
  assert.equal((await store.read(unit)).verdict, null);

  const submitted = result(await runUnitCli(['unit', 'stage', 'submit', reviewer, 'review', '--by', 'user', '--output', outputPath], options));
  const target = await store.read(unit);
  assert.equal(submitted.code, 0);
  assert.equal(submitted.state, 'Closed');
  assert.equal(submitted.targetUnit, unit);
  assert.equal(submitted.targetState, 'InReview');
  assert.equal(target.verdict, 'ship');
  assert.equal(target.reviewedHead, 'head-1');
  assert.equal(target.reviewDecision.by, 'user');
  assert.equal(target.reviewDecision.submissionId, 'user-review-1');
  assert.equal(target.findings.at(-1).id, 'F-1');
  assert.deepEqual((await store.read(reviewer)).findings, []);

  const accepted = result(await runUnitCli(['unit', 'accept', unit], { stateRoot, adapters: acceptanceAdapters().adapters }));
  assert.equal(accepted.state, 'Accepted', JSON.stringify(accepted));
  assert.equal((await store.read(unit)).accepted.basis, 'review');
});

test('review rejects stale targets and must-fix ship, while a fix verdict returns the target to Implementing', async t => {
  const stale = await fixture(t);
  const staleReviewer = 'review-stale';
  await prepareReviewTarget(stale.store, stale.unit);
  await createReviewUnit(stale.store, staleReviewer, stale.unit);
  const options = { stateRoot: stale.stateRoot, contractsDir: path.join(repo, 'skills'), adapters: stale.adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', staleReviewer, 'review'], options));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const outputPath = path.join(stale.stateRoot, 'review-stale-output.json');
  const finding = { id: 'F-1', kind: 'review', severity: 'must-fix', site: 'scripts/unit.mjs:1', claim: 'Crash', case: 'Invalid input', fix: 'Validate the request' };
  const output = { inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'stale-review', status: 'done', summary: 'Review', findings: [finding], verdict: 'ship', reviewedHead: input.head };
  await writeFile(outputPath, JSON.stringify(output));
  const mustFix = result(await runUnitCli(['unit', 'stage', 'submit', staleReviewer, 'review', '--output', outputPath], options));
  assert.equal(mustFix.code, 2);
  assert.equal((await stale.store.read(stale.unit)).verdict, null);
  await stale.store.update(stale.unit, current => ({ ...current, head: 'head-2', contentFingerprint: 'sha256:changed' }));
  await writeFile(outputPath, JSON.stringify({ ...output, submissionId: 'stale-target-review', findings: [], reviewedHead: 'head-2' }));
  const staleResult = result(await runUnitCli(['unit', 'stage', 'submit', staleReviewer, 'review', '--output', outputPath], options));
  assert.equal(staleResult.error, 'STAGE_STALE');
  assert.equal((await stale.store.read(stale.unit)).verdict, null);

  const fix = await fixture(t);
  const fixReviewer = 'review-fix';
  await prepareReviewTarget(fix.store, fix.unit);
  await createReviewUnit(fix.store, fixReviewer, fix.unit);
  const fixOptions = { stateRoot: fix.stateRoot, contractsDir: path.join(repo, 'skills'), adapters: fix.adapters };
  const fixOpen = result(await runUnitCli(['unit', 'stage', 'open', fixReviewer, 'review'], fixOptions));
  const fixInput = JSON.parse(await readFile(fixOpen.input, 'utf8'));
  const fixPath = path.join(fix.stateRoot, 'review-fix-output.json');
  await writeFile(fixPath, JSON.stringify({
    inputDigest: fixInput.inputDigest, attempt: fixInput.attempt, submissionId: 'fix-review', status: 'done', summary: 'Changes required',
    findings: [], verdict: 'fix', reviewedHead: fixInput.head,
  }));
  const fixResult = result(await runUnitCli(['unit', 'stage', 'submit', fixReviewer, 'review', '--output', fixPath], fixOptions));
  assert.equal(fixResult.state, 'Closed');
  assert.equal((await fix.store.read(fix.unit)).state, 'Implementing');
});

test('impl-risk acceptance requires named passing risk-gate evidence and a stable Git target', async t => {
  const { stateRoot, unit, store } = await fixture(t);
  await prepareAcceptanceRecord(store, unit, { kind: 'impl-risk', review: { mode: 'none', by: 'session', triggers: [] } });
  const missingRisk = acceptanceAdapters().adapters;
  const rejected = result(await runUnitCli(['unit', 'accept', unit], { stateRoot, adapters: missingRisk }));
  assert.equal(rejected.code, 1);
  assert.equal((await store.read(unit)).state, 'SelfGated');

  const validAssessment = {
    threats: ['untrusted input'], boundaries: ['gate runner'],
    scenarios: [{ acceptanceRef: 'AC-1', gate: 'risk-scenarios', testId: 'risk validation AC-1' }],
  };
  await store.update(unit, current => ({ ...current, riskAssessment: validAssessment, evidence: [] }));
  const valid = result(await runUnitCli(['unit', 'accept', unit], { stateRoot, adapters: acceptanceAdapters().adapters }));
  assert.equal(valid.code, 0);
  assert.equal((await store.read(unit)).state, 'Accepted');

  const changed = await fixture(t);
  await prepareAcceptanceRecord(changed.store, changed.unit);
  const driftAdapters = acceptanceAdapters({ liveTargets: [
    { head: 'head-1', contentFingerprint: 'sha256:content' },
    { head: 'head-1', contentFingerprint: 'sha256:content' },
    { head: 'head-2', contentFingerprint: 'sha256:changed' },
  ] }).adapters;
  const stale = result(await runUnitCli(['unit', 'accept', changed.unit], { stateRoot: changed.stateRoot, adapters: driftAdapters }));
  assert.equal(stale.code, 1);
  assert.equal((await changed.store.read(changed.unit)).state, 'SelfGated');
  assert.equal((await changed.store.read(changed.unit)).accepted, null);
});

test('handoff prose cannot bypass verified session finalization', async t => {
  const f = await fixture(t);
  await f.store.update(f.unit, record => ({ ...record, state: 'Delivered', acceptance: [], evidence: [], changedPaths: [], next: { unit: 'next' },
    sessionFinalization: { owner: { sessionId: 'owner' } } }));
  const context = { stateRoot: f.stateRoot, contractsDir: path.join(repo, 'skills'), adapters: f.adapters };
  const opened = result(await runUnitCli(['unit', 'stage', 'open', f.unit, 'handoff'], context));
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = JSON.parse(await readFile(opened.input, 'utf8'));
  const output = path.join(f.root, 'handoff-output.json');
  await writeFile(output, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt, submissionId: 'handoff-draft', status: 'done', summary: 'Prepared result draft', handoff: {} }));
  assert.equal(result(await runUnitCli(['unit', 'stage', 'submit', f.unit, 'handoff', '--output', output], context)).code, 0);
  assert.equal((await f.store.read(f.unit)).state, 'Delivered');
});

test('acceptance cannot commit a policy snapshot superseded during gates', async t => {
  const {stateRoot,unit,store}=await fixture(t);
  await prepareAcceptanceRecord(store,unit,{review:{mode:'none',by:'session',triggers:[]}});
  const adapters=acceptanceAdapters().adapters, run=adapters.gates.run;
  adapters.now=()=> '2026-01-01T00:00:00Z';
  adapters.provider={async verifyUserInput(input){return {...input,verified:true}}};
  let changed=false;
  adapters.gates.run=async gate=>{
    if(!changed){changed=true;const {changeUnitPolicy}=await import('./lib/unit-policy-change.mjs');
      const revision=(await store.read(unit)).revision;
      await changeUnitPolicy({stateRoot,store,unit,request:{id:'race',expectedRevision:revision,delivery:'merge',reason:'authorized'},userInputRef:'request',adapters});}
    return run(gate);
  };
  const response=result(await runUnitCli(['unit','accept',unit],{stateRoot,adapters}));
  assert.equal(response.code,1,JSON.stringify(response)); assert.match(response.summary,/Policy changed/);
  const current=await store.read(unit); assert.equal(current.state,'SelfGated'); assert.equal(current.policyOverrides.delivery,'merge'); assert.equal(current.accepted,null);
});

test('acceptance rejects policy changed away and back during gates', async t => {
  const {stateRoot,unit,store}=await fixture(t);
  await prepareAcceptanceRecord(store,unit,{review:{mode:'none',by:'session',triggers:[]}});
  const adapters=acceptanceAdapters().adapters, run=adapters.gates.run;
  adapters.now=()=> '2026-01-01T00:00:00Z'; adapters.provider={async verifyUserInput(input){return {...input,verified:true}}};
  let changed=false;
  adapters.gates.run=async gate=>{
    if(!changed){changed=true;const {changeUnitPolicy}=await import('./lib/unit-policy-change.mjs');
      for(const delivery of ['merge','none']){const revision=(await store.read(unit)).revision;
        await changeUnitPolicy({stateRoot,store,unit,request:{id:`change-${delivery}`,expectedRevision:revision,delivery,reason:'authorized'},userInputRef:'request',adapters});}}
    return run(gate);
  };
  const response=result(await runUnitCli(['unit','accept',unit],{stateRoot,adapters}));
  assert.equal(response.code,1,JSON.stringify(response)); assert.match(response.summary,/Policy changed/);
  assert.equal((await store.read(unit)).state,'SelfGated');
});

async function exhaustedGateFixture(t, review = { mode: 'none', by: 'session', triggers: [] }) {
  const { root, stateRoot, unit, store, adapters, checkpointChanges } = await fixture(t);
  await prepareAcceptanceRecord(store, unit, { review });
  await store.update(unit, current => ({ ...current, scopePaths: ['tests.mjs'],
    policy: { ...current.policy, retry: { onExhaustion: 'root-cause' } },
    policySources: { 'retry.onExhaustion': 'project' } }));
  let sequence = 0;
  let content = 'source:tests';
  let red = ['first AC-1', 'second AC-2'];
  let testRuns = 0;
  let variant = 'tests';
  adapters.id = () => `failure-${++sequence}`;
  adapters.git.inspectUnit = async () => ({ head: 'head-1', contentFingerprint: content });
  adapters.gates = { async describe(id) {
    return { id, format: 'tap', acPattern: 'AC-[12]', command: ['node', 'check', id === 'tests' ? variant : id],
      files: [{ path: `${id}.mjs`, content: await readFile(path.join(root, `${id}.mjs`)) }] };
  } };
  adapters.command = async (_binary, args) => {
    const isTests = args.at(-1) === variant;
    if (isTests) testRuns++;
    const cases = ['first AC-1', 'second AC-2'].map((name, index) =>
      `${isTests && red.includes(name) ? 'not ok' : 'ok'} ${index + 1} - ${name}`);
    return { exitCode: isTests && red.length ? 1 : 0, stdout: `TAP version 13\n${cases.join('\n')}\n1..2\n` };
  };
  const call = async (...args) => result(await runCoreUnitCli(args, { cwd: root, stateRoot, contractsDir: path.join(repo, 'skills'), adapters }));
  const write = async (name, value) => {
    const file = path.join(stateRoot, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  const stage = async (name, fields, edit) => {
    checkpointChanges.set(unit, { firstCheckpointDiff: [], attemptDiff: [] });
    const opened = await call('unit', 'stage', 'open', unit, name);
    assert.equal(opened.code, 0, JSON.stringify(opened));
    const { inputDigest, attempt } = JSON.parse(await readFile(opened.input));
    await edit?.();
    return call('unit', 'stage', 'submit', unit, name, '--output', await write(`${name}.json`, {
      inputDigest, attempt, submissionId: `${name}-${attempt}`, status: 'done', summary: 'Verified stage output', ...fields,
    }));
  };
  const diagnose = () => stage('root-cause', { assumptions: [], findings: [{
    id: 'D-1', kind: 'diagnosis', classification: 'product', severity: 'should-fix', site: 'tests.mjs',
    case: 'The two observed cases do not meet the requirement', claim: 'The shared implementation violates the cases', fix: 'Correct the shared implementation',
  }] });
  const implement = (next, remaining = red) => stage('implement', { changedPaths: ['tests.mjs'], coverage: [], assumptions: [], openDecisions: [] }, async () => {
    content = next;
    red = remaining;
    await writeFile(path.join(root, 'tests.mjs'), content);
    checkpointChanges.set(unit, { firstCheckpointDiff: ['tests.mjs'], attemptDiff: ['tests.mjs'] });
  });
  const accept = () => call('unit', 'accept', unit);
  const failure = await write('failure.json', { class: 'product', failurePoint: 'gate:tests', reason: 'the requested cases fail' });
  const fail = () => call('unit', 'fail', unit, '--gate', 'tests', '--failure', failure);
  const retry = causeKey => call('unit', 'retry', unit, '--cause-key', causeKey);
  assert.equal((await accept()).code, 1);
  assert.equal((await fail()).action, 'retry');
  assert.equal((await implement('first bounded repair')).code, 0);
  assert.equal((await accept()).code, 1);
  const second = await fail();
  assert.equal(second.action, 'diagnose', JSON.stringify(second));
  assert.equal((await retry(second.causeKey)).error, 'DIAGNOSIS_REQUIRED');
  assert.equal((await diagnose()).code, 0);
  assert.equal((await retry(second.causeKey)).action, 'retry');
  assert.equal((await implement('second bounded repair')).code, 0);
  assert.equal((await accept()).code, 1);
  const stopped = await fail();
  assert.equal(stopped.state, 'Stopped', JSON.stringify(stopped));
  assert.equal(stopped.action, 'stop');
  return { root, stateRoot, unit, store, call, write, diagnose, implement, accept, retry: () => retry(stopped.causeKey),
    causeKey: stopped.causeKey, testRuns: () => testRuns, changeCommand: () => { variant = 'alternate'; } };
}

test('AC-1 AC-2 AC-3 exhausted gate continues through successive verified repairs on the same unit', async t => {
  const f = await exhaustedGateFixture(t, { mode: 'required', by: 'session', triggers: [] });
  const before = await f.store.read(f.unit);
  assert.equal((await f.retry()).error, 'DIAGNOSIS_REQUIRED');
  assert.equal((await f.diagnose()).code, 0);
  const attempts = await Promise.all([f.retry(), f.retry()]);
  assert.equal(attempts.filter(item => item.action === 'repair').length, 1);
  assert.equal((await f.implement('partially corrected', ['second AC-2'])).code, 0);
  const partial = await f.accept();
  assert.equal(partial.state, 'Stopped', JSON.stringify(partial));
  assert.equal(partial.progress, true);
  assert.equal((await f.retry()).error, 'DIAGNOSIS_REQUIRED');
  assert.equal((await f.diagnose()).code, 0);
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('fully corrected', [])).code, 0);
  const review = await f.accept();
  assert.equal(review.code, 20, JSON.stringify(review));
  const after = await f.store.read(f.unit);
  assert.equal(after.accepted, null);
  assert.deepEqual(after.failures.slice(0, before.failures.length), before.failures);
  assert.deepEqual(after.evidence.slice(0, before.evidence.length), before.evidence);
  assert.deepEqual(after.retryContinuations.map(receipt => receipt.result.progress), [true, true]);
  assert.equal(after.retryContinuations[1].result.passed, true);
  assert.equal(after.retryContinuations[0].diagnosis.failureId, before.gateRecovery.failureId);
  assert.equal(after.retryContinuations[0].policy.source, 'project');
  const cause = (await createRecoveryStore(f.stateRoot).causes())[f.causeKey];
  assert.equal(cause.retries, 2);
  assert.equal(cause.occurrences, 4);
});

test('AC-2 exhausted gate stops when a changed repair does not advance the failed cases', async t => {
  const f = await exhaustedGateFixture(t);
  assert.equal((await f.diagnose()).code, 0);
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('unrelated change')).code, 0);
  const stopped = await f.accept();
  assert.equal(stopped.progress, false, JSON.stringify(stopped));
  const runs = f.testRuns();
  const before = await f.store.read(f.unit);
  assert.equal(before.state, 'Stopped');
  assert.equal((await f.retry()).error, 'RETRY_NOT_ALLOWED');
  assert.equal((await f.accept()).error, 'INVALID_TRANSITION');
  assert.equal(f.testRuns(), runs);
  assert.deepEqual(await f.store.read(f.unit), before);
});

test('AC-2 unresolved effects fence gate repair and a changed gate command cannot revalidate it', async t => {
  const f = await exhaustedGateFixture(t);
  assert.equal((await f.diagnose()).code, 0);
  const { createLedgerStore } = await import('./lib/ledger.mjs');
  const intent = { event: 'intent', seq: 1, key: 'remote-push', effect: 'git.push' };
  const ledger = createLedgerStore(f.stateRoot);
  await ledger.withLock(f.unit, async store => {
    await store.append(intent);
    await store.append({ ...intent, event: 'result', result: { status: 'uncertain' } });
  });
  const before = await f.store.read(f.unit);
  assert.equal((await f.retry()).error, 'EFFECT_UNCERTAIN');
  assert.deepEqual(await f.store.read(f.unit), before);
  await ledger.withLock(f.unit, store => store.append({ ...intent, event: 'result', result: { status: 'completed' } }));
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('corrected', [])).code, 0);
  f.changeCommand();
  const runs = f.testRuns();
  assert.equal((await f.accept()).error, 'RETRY_NO_PROGRESS');
  assert.equal(f.testRuns(), runs);
  assert.equal((await f.store.read(f.unit)).state, 'SelfGated');
});

test('AC-2 changed targets with identical gate inputs never execute another exhausted trial', async t => {
  const f = await exhaustedGateFixture(t);
  assert.equal((await f.diagnose()).code, 0);
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('unrelated-target')).code, 0);
  await writeFile(path.join(f.root, 'tests.mjs'), 'second bounded repair');
  const runs = f.testRuns();
  assert.equal((await f.accept()).error, 'RETRY_NO_PROGRESS');
  assert.equal(f.testRuns(), runs);
});

test('AC-2 a repair that regresses a previously corrected case cannot continue', async t => {
  const f = await exhaustedGateFixture(t);
  assert.equal((await f.diagnose()).code, 0);
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('partial-fix', ['second AC-2'])).code, 0);
  assert.equal((await f.accept()).progress, true);
  assert.equal((await f.diagnose()).code, 0);
  assert.equal((await f.retry()).action, 'repair');
  assert.equal((await f.implement('regressed-fix', ['first AC-1'])).code, 0);
  assert.equal((await f.accept()).progress, false);
  assert.equal((await f.store.read(f.unit)).gateRecovery.status, 'no-progress');
});
