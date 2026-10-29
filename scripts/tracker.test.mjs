import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { closeDeliveredUnit, createProjectionQueue, projectUnit, reconcileProjectionQueue } from './lib/tracker.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-tracker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'common.git', 'work-state');
  const adapters = { id: () => 'queue-1', now: () => '2026-01-02T03:04:05.000Z' };
  const store = createUnitStateStore(stateRoot);
  return { root, stateRoot, store, queue: createProjectionQueue(stateRoot, adapters), adapters };
}

function record(unit, state = 'Implementing', tracker = { adapter: 'stub', ref: `ref-${unit}`, projected: false }) {
  return { schema: 'harness.unit/1', unit, revision: 1, kind: 'impl', state, request: 'request', canon: [], policy: { goal: { class: 'task' } }, tracker, isolation: 'shared', stages: [], acceptance: [], openDecisions: [] };
}

test('projection failures are queued once and successful reconciliation clears the queue', async t => {
  const { store, queue } = await fixture(t);
  await store.create(record('unit-a'));
  const failed = await projectUnit(await store.read('unit-a'), {
    async read() { throw new Error('tracker unavailable'); }, async project() {},
  }, queue);
  assert.equal(failed.status, 'queued');
  await projectUnit(await store.read('unit-a'), {
    async read() { throw new Error('tracker unavailable'); }, async project() {},
  }, queue);
  assert.equal((await queue.pending()).length, 1);
  let projected;
  const results = await reconcileProjectionQueue({
    queue, store,
    adapter: { async read() { return null; }, async project(ref, value) { projected = { ref, value }; } },
  });
  assert.equal(results[0].status, 'projected');
  assert.equal(projected.value.state, 'Implementing');
  assert.deepEqual(await queue.pending(), []);
  assert.equal((await store.read('unit-a')).state, 'Implementing');
});

test('malformed queue locks stop with an explicit error and are not stolen', async t => {
  const { stateRoot, queue } = await fixture(t);
  const lock = path.join(stateRoot, 'projection-queue.ndjson.lock');
  await mkdir(stateRoot, { recursive: true });
  await writeFile(lock, '{partial');
  await assert.rejects(() => queue.enqueue({ unit: 'unit-lock', tracker: { ref: 'tracker' }, projection: { revision: 1 } }), { code: 'PROJECTION_LOCK_INVALID' });
  assert.equal(await readFile(lock, 'utf8'), '{partial');
});

test('terminal projection failure holds Delivered and reconciles the same revision before Closed', async t => {
  const { store, queue } = await fixture(t);
  await store.create(record('unit-b', 'Delivered'));
  const pending = await closeDeliveredUnit({
    store, unit: 'unit-b', queue, now: () => '2026-01-02T03:04:05.000Z',
    adapter: { async read() { throw new Error('offline'); }, async project() {} },
  });
  assert.equal(pending.state, 'Delivered');
  assert.equal(pending.closePending, true);
  const queued = (await queue.pending())[0];
  let projection;
  const outcomes = await reconcileProjectionQueue({
    queue, store,
    adapter: { async read() { return null; }, async project(ref, value) { projection = value; } },
  });
  assert.equal(outcomes[0].status, 'projected');
  assert.deepEqual(projection, { unit: 'unit-b', state: 'Closed', revision: 3 });
  assert.equal((await store.read('unit-b')).state, 'Closed');
  assert.equal((await store.read('unit-b')).tracker.projected, true);
  assert.equal((await store.read('unit-b')).tracker.projectionRevision, queued.projection.revision);
});

test('unit close and reconcile commands keep terminal tracker projection as the closing gate', async t => {
  const { stateRoot, store, adapters } = await fixture(t);
  await store.create(record('unit-cli', 'Delivered'));
  const options = { stateRoot, adapters: {
    ...adapters,
    tracker: { async read() { throw new Error('offline'); }, async project() {} },
  } };
  const close = JSON.parse((await runUnitCli(['unit', 'close', 'unit-cli'], options)).split('\n').at(-1).slice('RESULT '.length));
  assert.equal(close.code, 3);
  assert.equal((await store.read('unit-cli')).state, 'Delivered');
  const reconcile = JSON.parse((await runUnitCli(['unit', 'reconcile', 'unit-cli'], {
    ...options,
    adapters: { ...adapters, tracker: { async read() { return null; }, async project() {} } },
  })).split('\n').at(-1).slice('RESULT '.length));
  assert.equal(reconcile.code, 0);
  assert.equal((await store.read('unit-cli')).state, 'Closed');
});

test('deferred acceptance criteria block terminal close before tracker projection', async t => {
  const { stateRoot, store, adapters } = await fixture(t);
  const unit = record('unit-deferred', 'Delivered');
  unit.acceptance = [{ id: 'AC-1', status: 'deferred' }];
  await store.create(unit);
  let projections = 0;
  const output = JSON.parse((await runUnitCli(['unit', 'close', unit.unit], {
    stateRoot,
    adapters: { ...adapters, tracker: { async read() { return null; }, async project() { projections += 1; } } },
  })).split('\n').at(-1).slice('RESULT '.length));
  assert.equal(output.code, 1);
  assert.equal(output.error, 'DEFERRED_ACCEPTANCE');
  assert.equal(projections, 0);
  assert.equal((await store.read(unit.unit)).state, 'Delivered');
});

test('worktrees sharing a Git common directory use the same unit storage root', async t => {
  const { root, store } = await fixture(t);
  const commonDir = path.join(root, 'common.git');
  const first = path.join(root, 'worktree-one');
  const second = path.join(root, 'worktree-two');
  await Promise.all([mkdir(first), mkdir(second), mkdir(commonDir, { recursive: true })]);
  await store.create(record('worktree-one', 'Scoped'));
  await store.create(record('worktree-two', 'Scoped'));
  const adapters = {
    command: async (_command, _args, { cwd }) => ({ exitCode: 0, stdout: `${commonDir}\n`, cwd }),
    now: () => '2026-01-02T03:04:05.000Z',
    checkpoint: {
      async createCheckpoint({ ref }) { return { commit: `commit:${ref}`, worktreeChanged: false, indexChanged: false, excluded: [] }; },
    },
  };
  const outputs = await Promise.all(['worktree-one', 'worktree-two'].map((unit, index) => runUnitCli(
    ['unit', 'stage', 'open', unit, 'scope'],
    { cwd: index === 0 ? first : second, contractsDir: path.join(repo, 'skills'), adapters },
  )));
  for (const output of outputs) {
    const cli = JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
    assert.equal(cli.code, 0);
    assert.ok(cli.input.startsWith(path.join(commonDir, 'work-state')));
  }
  assert.ok(await readFile(path.join(commonDir, 'work-state', 'units', 'worktree-one', 'unit.json'), 'utf8'));
  assert.ok(await readFile(path.join(commonDir, 'work-state', 'units', 'worktree-two', 'unit.json'), 'utf8'));
});
