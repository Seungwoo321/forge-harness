import test from 'node:test';
import assert from 'node:assert/strict';
import { decideResume } from './lib/resume.mjs';

function record(overrides = {}) {
  return {
    schema: 'harness.unit/1', unit: 'UNIT-1', revision: 4, state: 'Blocked',
    blockedFrom: 'SelfGated', stoppedFrom: null, tracker: null, stages: [], accepted: null,
    ...overrides,
  };
}

function git(overrides = {}) {
  return { head: 'head-1', checkpoints: {}, worktreeDiff: [], indexDiff: [], ...overrides };
}

test('unresolved effect intent is reconciled before any later resume step', () => {
  const result = decideResume({
    record: record(),
    ledger: [{ event: 'intent', seq: 3, key: 'commit:1' }],
  });
  assert.deepEqual(result, {
    action: 'reconcile-effect', unit: 'UNIT-1', seq: 3, key: 'commit:1', resumeState: 'SelfGated',
  });
});

test('blocked and stopped states resume at the recorded state, not Implementing', () => {
  const blocked = decideResume({ record: record(), git: git() });
  const stopped = decideResume({
    record: record({ state: 'Stopped', blockedFrom: null, stoppedFrom: 'Delivering' }),
    git: git(),
  });
  assert.equal(blocked.state, 'SelfGated');
  assert.equal(blocked.stage, 'gates');
  assert.equal(stopped.state, 'Delivering');
  assert.equal(stopped.stage, 'delivery');
});

test('unknown or missing checkpoint state fails closed to Git inspection', () => {
  const result = decideResume({
    record: record({ stages: [{ name: 'implement', attempts: [{ n: 1, checkpoint: 'refs/harness/UNIT-1/implement.1' }] }] }),
    git: git(),
  });
  assert.equal(result.action, 'inspect-git');
  assert.equal(result.checkpoint, 'refs/harness/UNIT-1/implement.1');
});

test('changed accepted head or worktree content requires gate revalidation', () => {
  const result = decideResume({
    record: record({ state: 'Accepted', blockedFrom: null, accepted: { head: 'head-1', contentFingerprint: 'content-a' } }),
    git: git({ head: 'head-2' }),
  });
  assert.equal(result.action, 'revalidate');
  assert.equal(result.nextStage, 'gates');
});

test('stale evidence reruns its gate before tracker projection or stage resume', () => {
  const result = decideResume({
    record: record({ tracker: { ref: 'tracker-1' } }),
    git: git(),
    evidence: [{ gate: 'tests', fingerprint: 'sha256:old', exit: 0, failureClass: null }],
    currentFingerprints: { tests: 'sha256:new' },
    tracker: { state: 'Implementing', revision: 2 },
  });
  assert.equal(result.action, 'rerun-gate');
  assert.equal(result.gate, 'tests');
});

test('tracker mismatch is the final reconciliation step', () => {
  const result = decideResume({
    record: record({ tracker: { ref: 'tracker-1' } }),
    git: git(),
    tracker: { state: 'Implementing', revision: 3 },
  });
  assert.deepEqual(result, { action: 'project-tracker', unit: 'UNIT-1', resumeState: 'SelfGated', revision: 4 });
});

test('valid input returns the exact active state and stage', () => {
  const result = decideResume({
    record: record({ state: 'Implementing', blockedFrom: null }),
    git: git({ worktreeDiff: ['src/change.mjs'] }),
  });
  assert.deepEqual(result, {
    action: 'resume', unit: 'UNIT-1', state: 'Implementing', stage: 'implement',
    worktreeDiff: ['src/change.mjs'], indexDiff: [],
  });
});

test('missing Git snapshot cannot produce a resume action', () => {
  const result = decideResume({ record: record() });
  assert.equal(result.action, 'inspect-git');
});

test('invalid persisted state is rejected', () => {
  assert.throws(() => decideResume({ record: record({ state: 'Unknown' }), git: git() }), /valid persisted Unit Record/);
});
