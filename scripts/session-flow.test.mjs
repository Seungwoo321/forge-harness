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
import { finishSessionUnit, finalizeSessionUnit } from './lib/session-flow.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { taskDigest } from './lib/session-task.mjs';

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

test('final projection precedes launch but a process-only result cannot close the unit', async t => {
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
  assert.equal(outcome.code, 3);
  assert.match(outcome.summary, /receipt/);
  const record = await store.read('unit-finish');
  assert.equal(record.state, 'Delivered');
  assert.equal(record.next.unit, 'unit-next');
  assert.equal(record.tracker.projected, false);
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
  assert.equal(result.code, 3);
  assert.deepEqual(observed, ['/work/root with spaces', '/work/root with spaces']);
  assert.deepEqual(started, ['/work/root with spaces']);
  assert.equal((await store.read('unit-finish')).state, 'Delivered');
});

test('a mismatched current owner prevents session start and leaves the Unit Delivered', async t => {
  const { stateRoot, store, adapters } = await fixture(t, false);
  let starts = 0, receipt, closed = false, deliveries = 0;
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
  assert.equal(result.code, 3);
  assert.equal(record.state, 'Delivered');
  assert.equal(record.next.unit, 'unit-next');
  const intent = ledger.find(row => row.event === 'intent' && row.effect === 'session.start');
  assert.ok(intent);
  assert.equal(ledger.some(row => row.event === 'result' && row.seq === intent.seq), false);
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
  assert.equal((await finishSessionUnit(input)).code, 3);
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
  assert.equal((await finishSessionUnit(input)).code, 3);
  assert.equal(starts, 1);
  assert.equal((await f.store.read('unit-finish')).state, 'Delivered');
});


test('a legacy completed start is reobserved and supplemented without replacing its original rows', async t => {
  const f = await fixture(t, false);
  let starts = 0; let observations = 0;
  const input = { stateRoot: f.stateRoot, store: f.store, unit: 'unit-finish', resultFields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd: '/work/next' }, parentSessionId: 'parent-session', adapters: f.adapters,
    sessionAdapter: {
      async observe({ cwd }) { return { sessionId: 'parent-session', cwd }; },
      async execute() { starts += 1; throw Error('lost'); },
      async verify(input) {
        observations += 1;
        const identity = { sessionId: 'child', incarnationId: 'native-generation', cwd: input.args.cwd };
        return { status: 'completed', result: { ...identity, task: { ...identity, schema: 'harness.task-receipt/1', effectKey: input.key,
          promptDigest: taskDigest('original prompt'), threadId: 'thread', requestId: 'request', turnId: 'turn', activityId: 'activity',
          packets: [{ path: input.args.handoffPath, digest: input.args.handoffDigest }] } } };
      },
    },
  };
  await finishSessionUnit(input);
  const ledger = createLedgerStore(f.stateRoot);
  const prior = await ledger.withLock('unit-finish', async store => {
    const [intent] = await store.read();
    const legacy = { event: 'result', unit: intent.unit, seq: intent.seq, key: intent.key, result: { sessionId: 'child', cwd: '/work/next' }, done_at: f.adapters.now() };
    await store.append(legacy); return [intent, legacy];
  });
  const record = await f.store.read('unit-finish');
  const originalResult = await readFile(record.resultRef.path);
  const originalPacket = await readFile(record.next.handoff.path);
  for (const change of [
    { handoffContent: packet + '\nchanged' },
    { resultFields: { ...resultFields, remainingRisk: 'changed risk' } },
    { successor: { ...input.successor, attempt: 2 } },
    { successor: { ...input.successor, cwd: '/another' } },
  ]) {
    await assert.rejects(finishSessionUnit({ ...input, ...change }), { code: 'EFFECT_UNCERTAIN' });
    assert.deepEqual(await readFile(record.resultRef.path), originalResult);
    assert.deepEqual(await readFile(record.next.handoff.path), originalPacket);
    assert.deepEqual(await f.store.read('unit-finish'), record);
    assert.deepEqual(await ledger.withLock('unit-finish', store => store.read()), prior);
  }
  assert.equal((await finishSessionUnit(input)).code, 3);
  const rows = await ledger.withLock('unit-finish', store => store.read());
  assert.deepEqual(rows.slice(0, 2), prior);
  assert.equal(rows.at(-1).result.task.schema, 'harness.task-receipt/1');
  assert.equal(rows.filter(row => row.event === 'intent').length, 1);
  assert.equal(starts, 1); assert.equal(observations, 1);
  assert.deepEqual(await readFile(record.resultRef.path), originalResult);
});

test('managed goal remains open until verified successor receives both immutable packets', async t => {
  const f = await fixture(t, false);
  const { createContinuityStore } = await import('./lib/continuity-store.mjs');
  const { createHash } = await import('node:crypto');
  const source = path.join(f.root, 'goal.md');
  await writeFile(source, 'complete both units\n');
  const digest = `sha256:${createHash('sha256').update(await readFile(source)).digest('hex')}`;
  const goals = createContinuityStore(f.stateRoot);
  await goals.create({goal:{id:'goal1',objective:'complete both',criteria:['tested'],remaining:['unit-finish','unit-next'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest}});
  await goals.transaction('goal1', current => ({...current,revision:current.revision+1,bootstraps:[{unit:'unit-finish',sessionId:'parent',incarnationId:'parent-1',cwd:'/work/next'}]}));
  await f.store.update('unit-finish', current => ({...current,continuityRequired:true,continuity:{goalId:'goal1'}}));
  await createLedgerStore(f.stateRoot).withLock('unit-finish', async ledger => {
    await ledger.append({event:'intent',unit:'unit-finish',seq:1,effect:'session.start',key:'initial',args:{unit:'unit-finish',role:'implementation',attempt:1}});
    await ledger.append({event:'result',unit:'unit-finish',seq:1,key:'initial',result:{sessionId:'parent'}});
  });

  let starts = 0, receipt, closed = false, deliveries = 0;
  const sessionAdapter = {
    async observe({cwd}) { return {sessionId:'parent',incarnationId:'parent-1',cwd,runtime:'cmux',closable:true,worker:{incarnationId:'worker-1'}}; },
    async execute(input) {
      starts++;
      const identity = {sessionId:'child',incarnationId:'child-1',cwd:input.args.cwd};
      return receipt = {...identity,task:{...identity,schema:'harness.goal-receipt/1',effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:[{path:input.args.handoffPath,digest:input.args.handoffDigest},{path:input.args.goalPath,digest:input.args.goalDigest},{path:input.args.resultPath,digest:input.args.resultDigest}]}};
    },
    async verify(input) { if(input.effect === 'session.start') return {status:'completed',result:receipt}; if(input.effect === 'session.close' && closed) return {status:'completed',result:{sessionId:'parent',incarnationId:'parent-1',closed:true}}; return {status:'unknown'}; },
  };
  const originalExecute = sessionAdapter.execute;
  sessionAdapter.execute = async input => { if(input.effect === 'session.deliver') { deliveries++; throw new Error('duplicate delivery'); } if(input.effect === 'session.close') {closed=true; return {sessionId:'parent',incarnationId:'parent-1',closed:true};} return originalExecute(input); };
  const input = {stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,handoffContent:packet,successor:{approved:true,unit:'unit-next',cwd:'/work/next'},parentSessionId:'parent',parentRuntime:{sessionId:'parent',incarnationId:'parent-1',cwd:'/work/next'},adapters:f.adapters,sessionAdapter};
  await assert.rejects(finishSessionUnit({...input,successor:null,goalComplete:true}),{code:'GOAL_INCOMPLETE'});
  const outcome = await finishSessionUnit(input);
  assert.equal(outcome.finalizePending,true); assert.equal(starts,1);
  const goal = await goals.read('goal1');
  assert.deepEqual(goal.goal.remaining,['unit-next']);
  assert.equal(goal.transfers[0].unit,'unit-finish');
  assert.equal((await f.store.read('unit-finish')).state,'Delivered');
  assert.equal((await finishSessionUnit(input)).finalizePending,true);
  assert.equal(starts,1);
  const final = await finalizeSessionUnit({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',adapters:{...f.adapters,session:sessionAdapter}});
  assert.equal(final.state,'Closed'); assert.equal(deliveries,0); assert.equal(closed,true);
});

test('managed final completion requires covered goal criteria and records completion after unit closure', async t => {
  const f = await fixture(t, false);
  const { createContinuityStore } = await import('./lib/continuity-store.mjs');
  const { createHash } = await import('node:crypto');
  const source = path.join(f.root, 'goal.md'); await writeFile(source, 'finish the goal\n');
  const digest = `sha256:${createHash('sha256').update(await readFile(source)).digest('hex')}`;
  const goals = createContinuityStore(f.stateRoot);
  await goals.create({goal:{id:'goal2',objective:'finish',criteria:['behavior verified'],remaining:['unit-finish'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest}});
  await f.store.update('unit-finish', current => ({...current,continuityRequired:true,continuity:{goalId:'goal2'},acceptance:[{id:'AC-1',text:'behavior verified'}],evidence:[{gate:'tests',status:'passed',exit:0,covers:['AC-1']}]}));
  await goals.transaction('goal2', current => ({...current,revision:current.revision+1,bootstraps:[{unit:'unit-finish',sessionId:'parent',incarnationId:'parent-1',cwd:f.root}]}));
  const parentRuntime = {sessionId:'parent',incarnationId:'parent-1',cwd:f.root};
  const recipient = {sessionId:'supervisor',incarnationId:'supervisor-1',cwd:f.root,executable:'worker'};
  let closed = false;
  const session = {
    async observe(input) { return input.recipient ? recipient : {...parentRuntime,closable:true,worker:{incarnationId:'worker-1'}}; },
    async execute(input) {
      if (input.effect === 'session.close') { closed = true; return {sessionId:'parent',incarnationId:'parent-1',closed:true}; }
      const identity = {sessionId:'supervisor',incarnationId:'supervisor-1',cwd:f.root};
      return {...identity,task:{...identity,schema:'harness.task-receipt/1',effectKey:input.key,promptDigest:taskDigest('prompt'),threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets:[{path:input.args.resultPath,digest:input.args.resultDigest}]}};
    },
    async verify(input) { return input.effect === 'session.close' && closed ? {status:'completed',result:{sessionId:'parent',incarnationId:'parent-1',closed:true}} : {status:'unknown'}; },
  };
  const adapters = {...f.adapters,session};
  const input = {stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,goalComplete:true,parentRuntime,returnTo:recipient,adapters,sessionAdapter:session};
  await assert.rejects(finishSessionUnit(input),{code:'GOAL_INCOMPLETE'});
  const outcome = await finishSessionUnit({...input,goalProof:[{criterion:'behavior verified',unit:'unit-finish',acceptance:'AC-1'}]});
  assert.equal(outcome.finalizePending,true);
  assert.equal((await goals.read('goal2')).goal.status,'active');
  assert.equal((await finalizeSessionUnit({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',adapters})).state,'Closed');
  assert.equal((await goals.read('goal2')).goal.status,'complete');
});

test('finish rejects acceptance and delivery policy replaced after it began', async t => {
  const f=await fixture(t,false);
  await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  let resolveWaiting,resolveRelease;
  const waiting=new Promise(resolve=>{resolveWaiting=resolve}),release=new Promise(resolve=>{resolveRelease=resolve});
  t.after(()=>resolveRelease());
  let reads=0;
  const wrapped={...f.store,read:async unit=>{if(++reads===2){resolveWaiting();await release;}return f.store.read(unit);}};
  const finishing=finishSessionUnit({stateRoot:f.stateRoot,store:wrapped,unit:'unit-finish',resultFields,goalComplete:true,adapters:f.adapters});
  await waiting;
  const before=await f.store.read('unit-finish');
  const {changeUnitDelivery}=await import('./lib/unit-policy-change.mjs');
  const adapters={...f.adapters,provider:{async verifyUserInput(input){return {...input,verified:true};}}};
  await changeUnitDelivery({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',request:{id:'merge',expectedRevision:before.revision,delivery:'merge',reason:'user selected merge'},userInputRef:'user',adapters});
  await f.store.update('unit-finish',current=>({...current,state:'Accepted',accepted:{head:'head-1',contentFingerprint:'sha256:current',repo:'r',branch:'b',tree:'t',indexTree:'t',headTree:'t',base:'main'}}));
  const rejected=assert.rejects(finishing,{code:'DELIVERY_PLAN_MISMATCH'});
  resolveRelease(); await rejected;
  const current=await f.store.read('unit-finish'); assert.equal(current.state,'Accepted'); assert.equal(current.deliveryResult,undefined);
});

test('finish rejects policy changed away and back even if acceptance is identical', async t => {
  const f=await fixture(t,false); await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  let resolveWaiting,resolveRelease; const waiting=new Promise(resolve=>{resolveWaiting=resolve}),release=new Promise(resolve=>{resolveRelease=resolve}); t.after(()=>resolveRelease());
  let reads=0; const wrapped={...f.store,read:async unit=>{if(++reads===2){resolveWaiting();await release;}return f.store.read(unit);}};
  const original=await f.store.read('unit-finish');
  const finishing=finishSessionUnit({stateRoot:f.stateRoot,store:wrapped,unit:'unit-finish',resultFields,goalComplete:true,adapters:f.adapters}); await waiting;
  const {changeUnitDelivery}=await import('./lib/unit-policy-change.mjs'); const adapters={...f.adapters,provider:{async verifyUserInput(input){return {...input,verified:true};}}};
  for(const delivery of ['merge','none']){const current=await f.store.read('unit-finish');await changeUnitDelivery({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',request:{id:`change-${delivery}`,expectedRevision:current.revision,delivery,reason:'authorized'},userInputRef:'user',adapters});}
  await f.store.update('unit-finish',current=>({...current,state:'Accepted',accepted:original.accepted}));
  const rejected=assert.rejects(finishing,{code:'DELIVERY_PLAN_MISMATCH'}); resolveRelease(); await rejected;
  assert.equal((await f.store.read('unit-finish')).state,'Accepted');
});

test('approved same-session continuation closes only the unit and preserves remaining work', async t => {
  const f=await fixture(t,false); await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  let sessionEffects=0;
  const outcome=await finishSessionUnit({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,
    sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters,
    sessionAdapter:{async observe(){sessionEffects++;},async execute(){sessionEffects++;},async verify(){sessionEffects++;}}});
  assert.equal(outcome.code,0,JSON.stringify(outcome));assert.equal(outcome.state,'Closed');assert.equal(sessionEffects,0);
  const record=await f.store.read('unit-finish');assert.deepEqual(record.next,{unit:'next-work',sameSession:true});
  const text=await readFile(record.resultRef.path,'utf8');assert.match(text,/다음 작업 단위: next-work\n$/);assert.doesNotMatch(text,/단위 종료 —/);
  assert.deepEqual(await createLedgerStore(f.stateRoot).withLock('unit-finish',ledger=>ledger.read()),[]);
});

test('managed same-session continuation closes the unit and transfers its goal custody without launching', async t => {
  const f=await fixture(t,false); await f.store.update('unit-finish',current=>({...current,state:'Accepted',continuity:{goalId:'goal1'}}));
  const {createContinuityStore}=await import('./lib/continuity-store.mjs');
  const source=path.join(f.root,'goal.md');await writeFile(source,'goal');
  const goals=createContinuityStore(f.stateRoot);
  await goals.create({goal:{id:'goal1',objective:'goal',criteria:['done'],remaining:['unit-finish','unit-next'],status:'active'},
    policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest:taskDigest('goal')}});
  const owner={sessionId:'parent',incarnationId:'parent-1',cwd:'/work/next'};
  await goals.transaction('goal1',current=>({...current,revision:current.revision+1,bootstraps:[{unit:'unit-finish',...owner}]}));
  let effects=0;
  const outcome=await finishSessionUnit({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,parentRuntime:owner,
    sameSession:{approved:true,nextUnit:'unit-next'},adapters:f.adapters,sessionAdapter:{async observe(){effects++;},async execute(){effects++;},async verify(){effects++;}}});
  assert.equal(outcome.state,'Closed');assert.equal(effects,0);
  const goal=await goals.read('goal1');assert.deepEqual(goal.goal.remaining,['unit-next']);
  assert.deepEqual(goal.bootstraps.at(-1),{unit:'unit-next',attempt:1,...owner});
});

test('same-session continuation rejects conflicting transfer and changed retry', async t => {
  const f=await fixture(t,true);await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  const base={stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters};
  await assert.rejects(finishSessionUnit({...base,goalComplete:true}),{code:'SESSION_CONTINUATION_INVALID'});
  let fail=true;const trackerAdapter={async read(){return null;},async project(){if(fail)throw Error('temporarily unavailable');}};
  const first=await finishSessionUnit({...base,trackerAdapter});assert.equal(first.code,3);assert.equal((await f.store.read('unit-finish')).state,'Delivered');
  await assert.rejects(finishSessionUnit({...base,sameSession:{approved:true,nextUnit:'other-work'},trackerAdapter}),{code:'SESSION_CONTINUATION_CONFLICT'});
  await assert.rejects(finishSessionUnit({...base,sameSession:null,goalComplete:true,trackerAdapter}),{code:'SESSION_CONTINUATION_CONFLICT'});
  fail=false;const resumed=await finishSessionUnit({...base,trackerAdapter});assert.equal(resumed.code,0);assert.equal(resumed.state,'Closed');
});

test('same-session retry remains bound after a delivery commit advances accepted head', async t => {
  const f=await fixture(t,true);await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  let fail=true;const trackerAdapter={async read(){return null;},async project(){if(fail)throw Error('temporarily unavailable');}};
  const request={stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters,trackerAdapter};
  assert.equal((await finishSessionUnit(request)).code,3);
  await f.store.update('unit-finish',current=>({...current,accepted:{...current.accepted,validatedHead:'head-1',head:'commit-1'}}));
  f.adapters.git.inspectUnit=async()=>({head:'commit-1',contentFingerprint:'sha256:current'});
  fail=false;const result=await finishSessionUnit(request);assert.equal(result.code,0);assert.equal(result.state,'Closed');
});

test('same-session continuation safely rebinds after the changed target is reaccepted', async t => {
  const f=await fixture(t,false);await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  let head='head-2';f.adapters.git.inspectUnit=async()=>({head,contentFingerprint:'sha256:current'});
  const request={stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters};
  const first=await finishSessionUnit(request);assert.equal(first.code,1);let record=await f.store.read('unit-finish');assert.equal(record.state,'SelfGated');
  const previous=record.sameSessionContinuation.binding;
  await f.store.update('unit-finish',current=>({...current,state:'Accepted',accepted:{...current.accepted,head,validatedHead:head,contentFingerprint:'sha256:current'}}));
  const result=await finishSessionUnit(request);assert.equal(result.code,0,JSON.stringify(result));record=await f.store.read('unit-finish');
  assert.equal(record.state,'Closed');assert.equal(record.sameSessionContinuation.bindings.length,2);assert.equal(record.sameSessionContinuation.bindings[0],previous);
  assert.notEqual(record.sameSessionContinuation.binding,previous);
});

test('same-session retry cannot substitute a delivery level without an authorized policy change', async t => {
  const f=await fixture(t,false);await f.store.update('unit-finish',current=>({...current,state:'Accepted',policy:{...current.policy,delivery:'merge'}}));
  const inspect=f.adapters.git.inspectUnit;delete f.adapters.git.inspectUnit;
  const base={stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters};
  await assert.rejects(finishSessionUnit({...base,requestedDelivery:'push'}),{code:'ADAPTER_MISSING'});
  f.adapters.git.inspectUnit=inspect;
  await assert.rejects(finishSessionUnit({...base,requestedDelivery:'none'}),{code:'SESSION_CONTINUATION_CONFLICT'});
  const current=await f.store.read('unit-finish');assert.equal(current.state,'Accepted');assert.equal(current.sameSessionContinuation.delivery,'push');
});

test('same-session delivery may change after an authorized policy revision and reacceptance', async t => {
  const f=await fixture(t,false);await f.store.update('unit-finish',current=>({...current,state:'Accepted'}));
  delete f.adapters.git.inspectUnit;
  const base={stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',resultFields,sameSession:{approved:true,nextUnit:'next-work'},adapters:f.adapters};
  await assert.rejects(finishSessionUnit(base),{code:'ADAPTER_MISSING'});
  const {changeUnitDelivery}=await import('./lib/unit-policy-change.mjs');const current=await f.store.read('unit-finish');
  const adapters={...f.adapters,provider:{async verifyUserInput(input){return {...input,verified:true};}}};
  await changeUnitDelivery({stateRoot:f.stateRoot,store:f.store,unit:'unit-finish',request:{id:'merge',expectedRevision:current.revision,delivery:'merge',reason:'authorized'},userInputRef:'user',adapters});
  await f.store.update('unit-finish',r=>({...r,state:'Accepted',accepted:{head:'head-1',contentFingerprint:'sha256:current'}}));
  await assert.rejects(finishSessionUnit(base),{code:'ADAPTER_MISSING'});
  const updated=await f.store.read('unit-finish');assert.equal(updated.sameSessionContinuation.delivery,'merge');assert.equal(updated.sameSessionContinuation.bindings.length,2);
});
