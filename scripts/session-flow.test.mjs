import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters } from './lib/adapters.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { finishSessionUnit } from './lib/session-flow.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const packet = [
  '목표: finish the approved work',
  '수용 기준: all criteria pass',
  '작업관리: no tracker ticket',
  '결정: successor approved',
  '변경: scripts/session-flow.mjs',
  '검증: focused tests pass',
  '남은 일·위험: none',
  '다음 단위 첫 행동: read the handoff packet',
].join('\n');

async function fixture(t, tracker = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'work-state');
  const store = createUnitStateStore(stateRoot);
  await store.create({
    schema: 'harness.unit/1', unit: 'unit-finish', revision: 0, kind: 'impl', state: 'Delivered',
    request: 'finish', canon: [], policy: { goal: { class: 'product-prelaunch' }, delivery: 'none' },
    accepted: { head: 'head-1', contentFingerprint: 'sha256:current', basis: 'gates', verdictBy: null },
    tracker: tracker ? { adapter: 'stub', ref: 'tracker-1', projected: false } : null,
    isolation: 'shared', stages: [], acceptance: [], evidence: [], openDecisions: [],
  });
  const adapters = { ...createAdapters({ clock: () => new Date('2026-01-02T03:04:05.000Z'), id: () => 'effect-id' }),
    git: { async inspectUnit() { return { head: 'head-1', contentFingerprint: 'sha256:current' }; } },
  };
  return { root, stateRoot, store, adapters };
}

const resultFields = {
  title: 'Finished unit', objective: 'complete approved work', acceptance: 'all criteria pass', tracking: 'no tracker',
  decision: 'successor authorized', changed: 'scripts/session-flow.mjs', verification: 'focused checks pass',
  remainingRisk: 'none', nextFirstAction: 'read the handoff',
};

test('final projection precedes a new-session successor and the result records its handoff', async t => {
  const { stateRoot, store, adapters } = await fixture(t);
  const order = [];
  const outcome = await finishSessionUnit({
    stateRoot, store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', role: 'implementation', attempt: 1, cwd: '/work/next' },
    parentSessionId: 'parent-session', requestedDelivery: 'none', adapters,
    trackerAdapter: {
      async read() { return null; },
      async project(_ref, projection) { order.push(`tracker:${projection.state}`); },
    },
    sessionAdapter: {
      async observe({ cwd }) { order.push(`owner:${cwd}`); return { sessionId: 'parent-session', cwd }; },
      async execute(request) { order.push(`session:${request.args.unit}`); return { sessionId: 'child-session' }; },
      async verify() { return { status: 'unknown' }; },
    },
  });
  assert.deepEqual(order, ['owner:/work/next', 'tracker:Closed', 'owner:/work/next', 'session:unit-next']);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.sessionId, 'child-session');
  const record = await store.read('unit-finish');
  assert.equal(record.state, 'Closed');
  assert.equal(record.next.unit, 'unit-next');
  assert.equal(record.tracker.projected, true);
  const result = await readFile(record.resultRef.path, 'utf8');
  assert.match(result, /단위 종료 — 인계: .*unit-next/);
  assert.equal((await readFile(record.next.handoff.path, 'utf8')).trim(), packet);
  const ledger = await createLedgerStore(stateRoot).withLock('unit-finish', entries => entries.read());
  assert.equal(ledger.some(item => item.event === 'intent' && item.effect === 'session.start'), true);
});

test('delivery requests above policy and same-session successors fail before side effects', async t => {
  const denied = await fixture(t, false);
  let starts = 0;
  await assert.rejects(() => finishSessionUnit({
    stateRoot: denied.stateRoot, store: denied.store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', requestedDelivery: 'push', adapters: denied.adapters,
    sessionAdapter: { async observe() { return { sessionId: 'parent-session', cwd: '/work/next' }; }, async execute() { starts += 1; }, async verify() { return { status: 'unknown' }; } },
  }), { code: 'DELIVERY_DENIED' });
  await assert.rejects(() => finishSessionUnit({
    stateRoot: denied.stateRoot, store: denied.store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', sessionId: 'parent-session', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters: denied.adapters,
    sessionAdapter: { async observe() { return { sessionId: 'parent-session', cwd: '/work/next' }; }, async execute() { starts += 1; }, async verify() { return { status: 'unknown' }; } },
  }), /new session/);
  assert.equal(starts, 0);
  assert.equal((await denied.store.read('unit-finish')).state, 'Delivered');
});

test('an unresolved effect intent prevents result writing and session handoff', async t => {
  const { stateRoot, store, adapters } = await fixture(t, false);
  const ledgerStore = createLedgerStore(stateRoot);
  await ledgerStore.withLock('unit-finish', ledger => ledger.append({ event: 'intent', unit: 'unit-finish', seq: 1, key: 'pending' }));
  await assert.rejects(() => finishSessionUnit({
    stateRoot, store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters,
    sessionAdapter: { async observe({ cwd }) { return { sessionId: 'parent-session', cwd }; }, async execute() { throw new Error('must not run'); }, async verify() { return { status: 'unknown' }; } },
  }), { code: 'EFFECT_UNCERTAIN' });
  assert.equal((await store.read('unit-finish')).result, undefined);
});

test('unit finish CLI discovers the current owner and dispatches the exact cwd', async t => {
  const { stateRoot, store, root, adapters } = await fixture(t, false);
  const requestPath = path.join(root, 'finish.json');
  await writeFile(requestPath, JSON.stringify({
    resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', role: 'implementation', attempt: 1, cwd: '/work/root with spaces' },
    parentSessionId: 'parent-session', requestedDelivery: 'none',
  }));
  const observed = [];
  const started = [];
  const configuredAdapters = createAdapters({
    sessionRunner: {
      contractVersion: 'harness.session-adapter/1',
      capabilities: ['fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review'],
      async observe(input) { observed.push(input.cwd); return { sessionId: 'parent-session', cwd: input.cwd }; },
      async execute(input) { started.push(input.args.cwd); return { sessionId: 'child-session' }; },
      async verify() { return { status: 'unknown' }; },
    },
  });
  const output = await runUnitCli(['unit', 'finish', 'unit-finish', '--request', requestPath], {
    stateRoot,
    adapters: { ...adapters, session: configuredAdapters.session },
  });
  const result = JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
  assert.equal(result.code, 0);
  assert.deepEqual(observed, ['/work/root with spaces', '/work/root with spaces']);
  assert.deepEqual(started, ['/work/root with spaces']);
  assert.equal((await store.read('unit-finish')).state, 'Closed');
});

test('a mismatched current owner prevents session start and leaves the Unit Delivered', async t => {
  const { stateRoot, store, adapters } = await fixture(t, false);
  let starts = 0;
  const sessionAdapter = {
    async observe() { return { sessionId: 'other-session', cwd: '/work/next' }; },
    async execute() { starts += 1; return { sessionId: 'child-session' }; },
    async verify() { return { status: 'unknown' }; },
  };
  await assert.rejects(() => finishSessionUnit({
    stateRoot, store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters,
    sessionAdapter,
  }), { code: 'SESSION_OWNER_MISMATCH' });
  assert.equal(starts, 0);
  assert.equal((await store.read('unit-finish')).state, 'Delivered');
  const ledger = await createLedgerStore(stateRoot).withLock('unit-finish', entries => entries.read());
  assert.equal(ledger.some(item => item.event === 'intent' && item.effect === 'session.start'), false);
});

test('an unsupported session contract is rejected before Unit finish side effects', async t => {
  const { stateRoot, store, root, adapters } = await fixture(t, false);
  const requestPath = path.join(root, 'finish.json');
  await writeFile(requestPath, JSON.stringify({
    resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session',
  }));
  const configured = createAdapters({ sessionRunner: { contractVersion: 'unsupported', capabilities: [] } });
  const output = await runUnitCli(['unit', 'finish', 'unit-finish', '--request', requestPath], {
    stateRoot, adapters: { ...adapters, session: configured.session },
  });
  const result = JSON.parse(output.split('\n').at(-1).slice('RESULT '.length));
  assert.equal(result.code, 4);
  assert.equal((await store.read('unit-finish')).state, 'Delivered');
  const ledger = await createLedgerStore(stateRoot).withLock('unit-finish', entries => entries.read());
  assert.equal(ledger.some(item => item.event === 'intent' && item.effect === 'session.start'), false);
});

test('an uncertain runner result preserves its intent and does not launch the same successor again', async t => {
  const { stateRoot, store, adapters } = await fixture(t, false);
  let starts = 0;
  let verifications = 0;
  const sessionAdapter = {
    async observe({ cwd }) { return { sessionId: 'parent-session', cwd }; },
    async execute() { starts += 1; throw new Error('runner response lost'); },
    async verify() { verifications += 1; return { status: 'unknown' }; },
  };
  const input = {
    stateRoot, store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters,
    sessionAdapter,
  };
  const first = await finishSessionUnit(input);
  const second = await finishSessionUnit(input);
  assert.equal(first.code, 3);
  assert.equal(second.code, 3);
  assert.equal(starts, 1);
  assert.equal(verifications, 1);
  assert.equal((await store.read('unit-finish')).state, 'Delivered');
  const ledger = await createLedgerStore(stateRoot).withLock('unit-finish', entries => entries.read());
  assert.equal(ledger.filter(item => item.event === 'intent' && item.effect === 'session.start').length, 1);
  assert.equal(ledger.filter(item => item.event === 'result' && item.effect === 'session.start').length, 0);
});

test('a real CLI process observes its own cwd before dispatching a distinct successor process', async t => {
  const { stateRoot, store, root } = await fixture(t, false);
  const requestPath = path.join(root, 'finish.json');
  const tracePath = path.join(root, 'adapter-trace.json');
  const cwd = process.cwd();
  await writeFile(requestPath, JSON.stringify({
    resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', role: 'implementation', attempt: 1, cwd },
    parentSessionId: 'filled-by-runtime', requestedDelivery: 'none',
  }));
  const scriptPath = path.join(root, 'runtime-cli.mjs');
  const driverUrl = pathToFileURL(path.resolve('scripts/lib/unit-driver.mjs')).href;
  const adaptersUrl = pathToFileURL(path.resolve('scripts/lib/adapters.mjs')).href;
  await writeFile(scriptPath, `
    import { appendFile, readFile, writeFile } from 'node:fs/promises';
    import { spawnSync } from 'node:child_process';
    import { runUnitCli } from ${JSON.stringify(driverUrl)};
    import { createAdapters } from ${JSON.stringify(adaptersUrl)};
    const [stateRoot, requestPath, tracePath] = process.argv.slice(2);
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    request.parentSessionId = String(process.pid);
    await writeFile(requestPath, JSON.stringify(request));
    const trace = async event => appendFile(tracePath, JSON.stringify(event) + String.fromCharCode(10));
    const adapters = { ...createAdapters(), git: { async inspectUnit() { return { head: 'head-1', contentFingerprint: 'sha256:current' }; } } };
    const output = await runUnitCli(['unit', 'finish', 'unit-finish', '--request', requestPath], {
      cwd: process.cwd(), stateRoot,
      adapters: {
        ...adapters,
        session: {
          async observe({ cwd }) {
            await trace({ event: 'observe', sessionId: String(process.pid), cwd: process.cwd() });
            return { sessionId: String(process.pid), cwd: process.cwd() };
          },
          async execute({ args }) {
            const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({pid:process.pid,cwd:process.cwd()}))'], { cwd: args.cwd, encoding: 'utf8' });
            if (child.status !== 0) throw new Error(child.stderr);
            const runtime = JSON.parse(child.stdout);
            await trace({ event: 'execute', sessionId: String(runtime.pid), cwd: runtime.cwd });
            return { sessionId: String(runtime.pid), cwd: runtime.cwd };
          },
          async verify() { return { status: 'unknown' }; },
        },
      },
    });
    process.stdout.write(output + '\\n');
  `);
  const child = spawnSync(process.execPath, [scriptPath, stateRoot, requestPath, tracePath], { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const result = JSON.parse(child.stdout.split('\n').at(-2).slice('RESULT '.length));
  const record = await store.read('unit-finish');
  const ledger = await createLedgerStore(stateRoot).withLock('unit-finish', entries => entries.read());
  assert.equal(trace[0].event, 'observe');
  assert.equal(trace[0].cwd, cwd);
  assert.equal(trace[0].sessionId, String(child.pid));
  assert.equal(trace[1].event, 'observe');
  assert.equal(trace[2].event, 'execute');
  assert.equal(trace[2].cwd, cwd);
  assert.notEqual(trace[2].sessionId, trace[0].sessionId);
  assert.equal(result.code, 0);
  assert.equal(record.state, 'Closed');
  assert.equal(record.next.unit, 'unit-next');
  const intent = ledger.find(row => row.event === 'intent' && row.effect === 'session.start');
  assert.ok(intent);
  assert.equal(ledger.find(row => row.event === 'result' && row.seq === intent.seq)?.result?.sessionId, trace[2].sessionId);
});

test('Delivered retries revalidate accepted head and content before finish, close, or reconcile', async t => {
  for (const command of ['finish', 'close', 'reconcile']) {
    for (const changed of [{ head: 'head-2', contentFingerprint: 'sha256:current' }, { head: 'head-1', contentFingerprint: 'sha256:changed' }]) {
      const f = await fixture(t);
      await f.store.update('unit-finish', current => ({ ...current, state: 'Accepted' }));
      let target = { head: 'head-1', contentFingerprint: 'sha256:current' };
      let offline = true;
      let projections = 0;
      const adapters = { ...f.adapters, git: { async inspectUnit() { return target; } }, tracker: {
        async read() { if (offline) throw new Error('offline'); return null; },
        async project() { projections += 1; },
      } };
      const request = { stateRoot: f.stateRoot, store: f.store, unit: 'unit-finish', resultFields, goalComplete: true, adapters, trackerAdapter: adapters.tracker };
      assert.equal((await finishSessionUnit(request)).code, 3);
      assert.equal((await f.store.read('unit-finish')).state, 'Delivered');
      target = changed;
      offline = false;
      if (command === 'finish') assert.equal((await finishSessionUnit(request)).code, 1);
      else await runUnitCli(['unit', command, 'unit-finish'], { stateRoot: f.stateRoot, adapters });
      const record = await f.store.read('unit-finish');
      assert.equal(record.state, 'SelfGated', command);
      assert.equal(record.accepted, null);
      assert.equal(projections, 0);
    }
  }
});

test('uncertain start retries preserve original packet and result before reconciling', async t => {
  const f = await fixture(t, false);
  let starts = 0;
  let verifications = 0;
  const input = { stateRoot: f.stateRoot, store: f.store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters: f.adapters,
    sessionAdapter: {
      async observe({ cwd }) { return { sessionId: 'parent-session', cwd }; },
      async execute() { starts += 1; throw new Error('lost response'); },
      async verify() { verifications += 1; return { status: 'completed', result: { sessionId: 'child', cwd: '/work/next' } }; },
    },
  };
  assert.equal((await finishSessionUnit(input)).code, 3);
  const original = await f.store.read('unit-finish');
  const originalPacket = await readFile(original.next.handoff.path, 'utf8');
  const originalResult = await readFile(original.resultRef.path, 'utf8');
  for (const update of [{ handoffContent: packet.replace('검증: focused tests pass', '검증: different evidence') }, { resultFields: { ...resultFields, verification: 'different result' } }]) {
    await assert.rejects(() => finishSessionUnit({ ...input, ...update }), { code: 'EFFECT_UNCERTAIN' });
    assert.deepEqual(await f.store.read('unit-finish'), original);
    assert.equal(await readFile(original.next.handoff.path, 'utf8'), originalPacket);
    assert.equal(await readFile(original.resultRef.path, 'utf8'), originalResult);
  }
  assert.equal(starts, 1);
  assert.equal(verifications, 0);
  assert.equal((await finishSessionUnit(input)).code, 0);
  assert.equal(starts, 1);
  assert.equal(verifications, 1);
  assert.equal((await f.store.read('unit-finish')).next.handoff.digest, original.next.handoff.digest);
});

test('tracker reconcile and public close cannot close an approved successor before verified start', async t => {
  const f = await fixture(t);
  let offline = true;
  let starts = 0;
  const tracker = { async read() { if (offline) throw new Error('offline'); return null; }, async project() {} };
  const input = { stateRoot: f.stateRoot, store: f.store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters: f.adapters, trackerAdapter: tracker,
    sessionAdapter: {
      async observe({ cwd }) { return { sessionId: 'parent-session', cwd }; },
      async execute() { starts += 1; return { sessionId: 'child', cwd: '/work/next' }; },
      async verify() { return { status: 'unknown' }; },
    },
  };
  assert.equal((await finishSessionUnit(input)).code, 3);
  offline = false;
  const options = { stateRoot: f.stateRoot, adapters: { ...f.adapters, tracker } };
  await runUnitCli(['unit', 'reconcile', 'unit-finish'], options);
  assert.equal((await f.store.read('unit-finish')).state, 'Delivered');
  await runUnitCli(['unit', 'close', 'unit-finish'], options);
  assert.equal((await f.store.read('unit-finish')).state, 'Delivered');
  assert.equal(starts, 0);
  assert.equal((await finishSessionUnit(input)).code, 0);
  assert.equal(starts, 1);
  assert.equal((await f.store.read('unit-finish')).state, 'Closed');
});
