import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDecisionStore } from './lib/decisions.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';

async function fixture(t, { state = 'Scoped', acceptance = [{ id: 'AC-1', text: 'First criterion', status: 'open' }, { id: 'AC-2', text: 'Second criterion', status: 'open' }], decisions = [{ id: 'D-1', kind: 'preference', question: 'Choose one', options: ['A', 'B'], blocks: ['AC-1'], requiredAction: null, canonRefs: ['docs/spec.md'], notifiedAt: null, answer: null }], digest = 'sha256:one' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUnitStateStore(root);
  await store.create({
    schema: 'harness.unit/1', unit: 'unit-a', revision: 0, kind: 'impl', state,
    blockedFrom: null, stoppedFrom: null, acceptance, openDecisions: decisions,
    canon: [{ path: 'docs/spec.md', digest }], policy: { escalation: { canonReviewAt: 5 } },
  });
  return { root, store, decisions: createDecisionStore(root) };
}

test('notification is recorded once, defers only listed criteria, and leaves unblocked work available', async t => {
  const f = await fixture(t);
  const first = await f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-1', now: '2026-01-01T00:00:00.000Z' });
  const duplicate = await f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-1', now: '2026-01-02T00:00:00.000Z' });
  assert.equal(first.record.state, 'Scoped');
  assert.deepEqual(first.record.acceptance.map(item => item.status), ['deferred', 'open']);
  assert.equal(first.record.openDecisions[0].notifiedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(duplicate.duplicate, true);
  assert.equal((await f.decisions.events()).filter(item => item.kind === 'notification').length, 1);
});

test('canon review is emitted once at the per-path digest threshold and changed content resets the count', async t => {
  const f = await fixture(t, { acceptance: [{ id: 'AC-1', status: 'open' }], decisions: [] });
  for (const [unit, id, digest] of [
    ['unit-a', 'D-1', 'sha256:one'],
    ['unit-b', 'D-2', 'sha256:one'],
    ['unit-c', 'D-3', 'sha256:one'],
    ['unit-d', 'D-4', 'sha256:two'],
  ]) {
    const value = {
      schema: 'harness.unit/1', unit, revision: 0, kind: 'impl', state: 'Scoped',
      blockedFrom: null, stoppedFrom: null, acceptance: [{ id: 'AC-1', status: 'open' }],
      openDecisions: [{ id, kind: 'external-access', question: 'Continue?', options: ['yes'], blocks: [], requiredAction: null, canonRefs: ['docs/spec.md'], notifiedAt: null, answer: null }],
      canon: [{ path: 'docs/spec.md', digest }], policy: {},
    };
    const record = unit === 'unit-a'
      ? await f.store.update(unit, current => ({ ...current, ...value }))
      : await f.store.create(value);
    assert.equal(record.unit, unit);
  }
  const results = [];
  for (const [unit, id] of [['unit-a', 'D-1'], ['unit-b', 'D-2'], ['unit-c', 'D-3'], ['unit-d', 'D-4']]) {
    results.push(await f.decisions.notify({ store: f.store, unit, decisionId: id, now: `2026-01-0${results.length + 1}T00:00:00.000Z`, threshold: 2 }));
  }
  assert.equal(results[0].escalation, null);
  assert.equal(results[1].escalation?.path, 'docs/spec.md');
  assert.equal(results[2].escalation, null);
  assert.equal(results[3].escalation, null);
  assert.equal((await f.decisions.events()).filter(item => item.kind === 'canon-review').length, 1);
});

test('unit stops when only deferred work remains and a resolved decision resumes its exact origin', async t => {
  const f = await fixture(t, { state: 'Implementing', acceptance: [{ id: 'AC-1', status: 'open' }] });
  const stopped = await f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-1', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(stopped.record.state, 'Stopped');
  assert.equal(stopped.record.stoppedFrom, 'Implementing');
  const resumed = await f.decisions.resolve({ store: f.store, unit: 'unit-a', decisionId: 'D-1', answer: 'A', now: '2026-01-02T00:00:00.000Z' });
  assert.equal(resumed.state, 'Implementing');
  assert.equal(resumed.stoppedFrom, null);
  assert.equal(resumed.acceptance[0].status, 'open');
});

test('resolving one of several blocking decisions leaves the unit stopped until all blocking work is available', async t => {
  const f = await fixture(t, {
    state: 'Implementing',
    decisions: [
      { id: 'D-1', kind: 'preference', question: 'Choose one', options: ['A', 'B'], blocks: ['AC-1'], requiredAction: null, canonRefs: ['docs/spec.md'], notifiedAt: null, answer: null },
      { id: 'D-2', kind: 'external-access', question: 'Grant access?', options: ['yes', 'no'], blocks: ['AC-2'], requiredAction: null, canonRefs: ['docs/spec.md'], notifiedAt: null, answer: null },
    ],
  });
  await f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-1', now: '2026-01-01T00:00:00.000Z' });
  await f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-2', now: '2026-01-02T00:00:00.000Z' });
  const first = await f.decisions.resolve({ store: f.store, unit: 'unit-a', decisionId: 'D-1', answer: 'A', now: '2026-01-03T00:00:00.000Z' });
  assert.equal(first.state, 'Stopped');
  assert.equal(first.acceptance[0].status, 'open');
  assert.equal(first.acceptance[1].status, 'deferred');
  const final = await f.decisions.resolve({ store: f.store, unit: 'unit-a', decisionId: 'D-2', answer: 'yes', now: '2026-01-04T00:00:00.000Z' });
  assert.equal(final.state, 'Implementing');
  assert.equal(final.acceptance[1].status, 'open');
});

test('invalid decision kinds and unknown blocked criteria fail closed', async t => {
  const f = await fixture(t, { decisions: [{ id: 'D-1', kind: 'other', blocks: ['missing'], canonRefs: ['docs/spec.md'] }] });
  await assert.rejects(() => f.decisions.notify({ store: f.store, unit: 'unit-a', decisionId: 'D-1', now: '2026-01-01T00:00:00.000Z' }), { code: 'DECISION_INVALID' });
});
