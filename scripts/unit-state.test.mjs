import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUnitStateStore, reconcileTracker, transitionRecord } from './lib/unit-state.mjs';

function record(unit, kind = 'impl') {
  return {
    schema: 'harness.unit/1', unit, revision: 0, kind, state: kind === 'review' ? 'InReview' : 'Scoped',
    blockedFrom: null, stoppedFrom: null, tracker: null,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-unit-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createUnitStateStore(root) };
}

test('creates and atomically updates one canonical Unit Record path', async t => {
  const { root, store } = await fixture(t);
  const created = await store.create(record('unit-a'));
  assert.equal(created.revision, 1);
  assert.equal(await store.location('unit-a'), path.join(root, 'units', 'unit-a', 'unit.json'));

  const implementing = await store.transition('unit-a', 'Implementing');
  const selfGated = await store.transition('unit-a', 'SelfGated');
  assert.equal(implementing.revision, 2);
  assert.equal(selfGated.revision, 3);
  assert.deepEqual(JSON.parse(await readFile(await store.location('unit-a'), 'utf8')), selfGated);
});

test('rejects invalid transitions with a stable code and reason', () => {
  assert.throws(
    () => transitionRecord(record('unit-a'), 'Accepted'),
    error => error.code === 'INVALID_TRANSITION' && error.reason === 'transition is not in the unit lifecycle',
  );
});

test('blocked and stopped units resume only at their recorded origin', () => {
  let current = transitionRecord({ ...record('unit-a'), state: 'Implementing' }, 'Blocked');
  assert.equal(current.blockedFrom, 'Implementing');
  assert.throws(() => transitionRecord(current, 'SelfGated'), { code: 'INVALID_TRANSITION' });
  current = transitionRecord(current, 'Implementing');
  assert.equal(current.blockedFrom, null);

  current = transitionRecord(current, 'Stopped');
  assert.equal(current.stoppedFrom, 'Implementing');
  current = transitionRecord(current, 'Implementing');
  assert.equal(current.stoppedFrom, null);
});

test('ops and review kinds use their restricted lifecycle paths', () => {
  const ops = transitionRecord(record('unit-ops', 'ops'), 'Closed');
  assert.equal(ops.state, 'Closed');
  assert.throws(() => transitionRecord(record('unit-ops', 'ops'), 'Implementing'), { code: 'INVALID_TRANSITION' });
  const review = transitionRecord(record('unit-review', 'review'), 'Closed');
  assert.equal(review.state, 'Closed');
});

test('concurrent updates preserve revisions and independent unit records', async t => {
  const { store } = await fixture(t);
  await Promise.all([store.create(record('unit-a')), store.create(record('unit-b'))]);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.update('unit-a', current => ({ ...current, count: (current.count ?? 0) + 1 }))));
  await store.update('unit-b', current => ({ ...current, marker: 'preserved' }));
  const a = await store.read('unit-a');
  const b = await store.read('unit-b');
  assert.equal(a.count, 12);
  assert.equal(a.revision, 13);
  assert.equal(b.marker, 'preserved');
  assert.equal(b.revision, 2);
});

test('tracker projection follows Unit Record state and never imports tracker state', async () => {
  const current = { ...record('unit-a'), revision: 4, state: 'SelfGated', tracker: { adapter: 'stub', ref: 'tracker-1' } };
  const writes = [];
  const result = await reconcileTracker(current, {
    async read() { return { state: 'Implementing', revision: 3 }; },
    async project(ref, projection) { writes.push({ ref, projection }); },
  });
  assert.deepEqual(result, { status: 'projected', revision: 4 });
  assert.deepEqual(writes, [{ ref: 'tracker-1', projection: { unit: 'unit-a', state: 'SelfGated', revision: 4 } }]);
  assert.equal(current.state, 'SelfGated');
});
