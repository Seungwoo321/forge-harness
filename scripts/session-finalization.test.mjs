import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { taskDigest } from './lib/session-task.mjs';

async function setup(t, mode = 'success') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-finalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUnitStateStore(root);
  await store.create({ schema: 'harness.unit/1', unit: 'finished', revision: 0, kind: 'impl', state: 'Delivered',
    policy: { goal: { class: 'product-prelaunch' }, delivery: 'none' }, accepted: { head: 'head', contentFingerprint: 'content' },
    acceptance: [], openDecisions: [], tracker: null });
  const owner = { runtime:'cmux', sessionId: 'owner', incarnationId: 'owner-generation', cwd: root, tty: 'tty-owner', closable: true,
    worker: { executable: 'worker', incarnationId: 'worker-generation', pid: 42, threadId:'owner-thread' } };
  const recipient = { sessionId: 'existing-parent', incarnationId: 'recipient-generation', cwd: root, executable: 'worker' };
  const events = [];
  let closed = false;
  let accepted = !['queued', 'prefilled', 'delivery-failed', 'pre-input', 'pre-input-stuck'].includes(mode);
  let deliveryAttempts = 0;
  const receipt = input => ({ ...recipient, task: { schema: 'harness.task-receipt/1', effectKey: input.key,
    sessionId: recipient.sessionId, incarnationId: recipient.incarnationId, cwd: root, promptDigest: taskDigest('native request'),
    threadId: 'thread', requestId: 'request', turnId: 'turn', activityId: 'activity',
    packets: [{ path: input.args.resultPath, digest: input.args.resultDigest }],
  } });
  const session = {
    async observe(input) { events.push('observe'); return input.recipient ? recipient : owner; },
    async execute(input) {
      events.push(input.effect);
      if (input.effect === 'session.start') throw Error('must return to existing owner');
      if (input.effect === 'session.deliver') {
        deliveryAttempts += 1;
        if (mode === 'prefilled' && deliveryAttempts === 2) accepted = true;
        if (mode === 'pre-input' && deliveryAttempts === 2) accepted = true;
        if (['pre-input', 'pre-input-stuck'].includes(mode) && !accepted) throw Object.assign(Error('packet reference does not fit the exact composer viewport'), { code: 'SESSION_OBSERVATION_INVALID' });
        if (!accepted) throw Error('queued, not yet consumed');
        const result = receipt(input);
        if (mode === 'bad-receipt') result.task.incarnationId = 'stale';
        return result;
      }
      assert.equal(input.args.owner.sessionId, 'owner');
      assert.equal(input.args.recipient.sessionId, 'existing-parent');
      if (mode === 'identity-drift' || mode === 'close-failed') throw Error(mode);
      closed = true;
      if (mode === 'lost-close-response') throw Error('caller exited before response');
      return { closed: true, sessionId: owner.sessionId, incarnationId: owner.incarnationId };
    },
    async verify(input) {
      events.push(`verify:${input.effect}`);
      if (input.effect === 'session.deliver' && accepted) return { status: 'completed', result: receipt(input) };
      if (input.effect === 'session.deliver' && ['prefilled', 'delivery-failed'].includes(mode)) return {
        status: 'not-applied', result: recipient, verify: { nativeRequestAbsent: true, exactPendingComposer: true },
      };
      if (input.effect === 'session.deliver' && ['pre-input', 'pre-input-stuck'].includes(mode)) return {
        status: 'not-applied', result: recipient, verify: { nativeRequestAbsent: true, preInputFailure: true },
      };
      if (input.effect === 'session.close' && closed) return { status: 'completed', result: { closed: true, sessionId: owner.sessionId, incarnationId: owner.incarnationId } };
      if (input.effect === 'session.close' && mode === 'close-failed') return { status: 'not-applied', result: { closed: false, sessionId: owner.sessionId, incarnationId: owner.incarnationId } };
      return { status: 'unknown' };
    },
  };
  const adapters = { ...createAdapters(), session, git: { async inspectUnit() { return { head: 'head', contentFingerprint: 'content' }; } } };
  const request = path.join(root, 'request.json');
  await writeFile(request, JSON.stringify({ goalComplete: true, parentRuntime: owner, returnTo: recipient,
    resultFields: { title: 'Completed work', objective: 'repair', acceptance: 'all pass', tracking: 'none', decision: 'return to owner', changed: 'source', verification: 'tests', remainingRisk: 'none', nextFirstAction: 'resume' } }));
  const run = async (command, extra = []) => {
    const output = await runUnitCli(['unit', command, 'finished', ...(command === 'finish' ? ['--request', request] : []), ...extra], { stateRoot: root, adapters });
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  };
  return { root, store, events, run, adapters, accept: () => { accepted = true; }, deliveries: () => deliveryAttempts, ledger: () => createLedgerStore(root).withLock('finished', ledger => ledger.read()) };
}

test('public finish persists existing-parent return; finalizer delivers and closes the exact owner', async t => {
  const f = await setup(t);
  assert.equal((await f.run('finish')).finalizePending, true);
  assert.equal((await f.store.read('finished')).state, 'Delivered');
  assert.equal((await f.run('close')).code, 3);
  assert.equal((await f.run('finalize')).code, 0);
  assert.equal((await f.store.read('finished')).state, 'Closed');
  assert.deepEqual(f.events.filter(e => !e.startsWith('observe')), ['session.deliver', 'session.close', 'verify:session.close']);
  assert.equal((await f.run('finalize')).code, 0);
  assert.equal(f.events.filter(e => e === 'session.close').length, 1);
});

for (const mode of ['bad-receipt', 'queued', 'identity-drift', 'close-failed']) {
  test(`public finalizer preserves Delivered and durable intent for ${mode}`, async t => {
    const f = await setup(t, mode);
    await f.run('finish');
    assert.equal((await f.run('finalize')).code, 3);
    assert.equal((await f.store.read('finished')).state, 'Delivered');
    const ledger = await f.ledger();
    assert.ok(ledger.some(row => row.event === 'intent'));
    if (['bad-receipt', 'queued'].includes(mode)) assert.equal(f.events.includes('session.close'), false);
  });
}

test('a delivery that failed before any input retries the same intent once the recipient is Ready', async t => {
  const f = await setup(t, 'pre-input');
  await f.run('finish');
  assert.equal((await f.run('finalize')).code, 3);
  assert.equal(f.deliveries(), 1);
  assert.ok((await f.ledger()).some(row => row.event === 'execution-error'));
  assert.equal((await f.run('finalize')).code, 0);
  assert.equal(f.deliveries(), 2);
  assert.equal((await f.store.read('finished')).state, 'Closed');
  assert.equal((await f.ledger()).filter(row => row.event === 'intent' && row.effect === 'session.deliver').length, 1);
});

test('repeated pre-input failures stop at the retry budget', async t => {
  const f = await setup(t, 'pre-input-stuck');
  await f.run('finish');
  for (let i = 0; i < 4; i += 1) assert.equal((await f.run('finalize')).code, 3);
  assert.equal(f.deliveries(), 2);
  assert.ok((await f.ledger()).some(row => row.event === 'verification' && row.verify?.code === 'SESSION_DELIVERY_RETRY_FAILED'));
  assert.equal((await f.store.read('finished')).state, 'Delivered');
});

test('an exhausted pre-input delivery budget reopens only under verified user input for the same intent', async t => {
  const f = await setup(t, 'pre-input-stuck');
  await f.run('finish');
  for (let i = 0; i < 3; i += 1) await f.run('finalize');
  assert.equal(f.deliveries(), 2);
  assert.equal((await f.run('finalize', ['--retry-delivery'])).error, 'CLI_USAGE');
  assert.equal((await f.run('finalize', ['--retry-delivery', '--user-input', 'retry-approved'])).error, 'EFFECT_APPROVAL_REQUIRED');
  assert.equal(f.deliveries(), 2);
  const checked = [];
  f.adapters.provider = { verifyUserInput: async input => { checked.push(input); return { ...input, verified: input.userInputRef === 'retry-approved' }; } };
  assert.equal((await f.run('finalize', ['--retry-delivery', '--user-input', 'retry-approved'])).code, 3);
  assert.equal(f.deliveries(), 3);
  const intent = (await f.ledger()).find(row => row.event === 'intent' && row.effect === 'session.deliver');
  assert.deepEqual(checked.map(({ effect, seq, key, failedAttempts }) => ({ effect, seq, key, failedAttempts })),
    [{ effect: 'unit.finalize.retry-delivery', seq: intent.seq, key: intent.key, failedAttempts: 2 }]);
  assert.equal((await f.ledger()).filter(row => row.event === 'delivery-retry-authorization').length, 1);
  await f.run('finalize'); await f.run('finalize');
  assert.equal(f.deliveries(), 4);
  f.accept();
  assert.equal((await f.run('finalize', ['--retry-delivery', '--user-input', 'retry-approved'])).code, 0);
  assert.equal((await f.ledger()).filter(row => row.event === 'delivery-retry-authorization').length, 2);
  assert.equal((await f.store.read('finished')).state, 'Closed');
});

test('queued result retry observes consumption without another submission', async t => {
  const f = await setup(t, 'queued');
  await f.run('finish');
  await f.run('finalize');
  const original = (await f.ledger())[0];
  f.accept();
  assert.equal((await f.run('finalize')).code, 0);
  assert.deepEqual((await f.ledger())[0], original);
  assert.equal(f.events.filter(e => e === 'session.deliver').length, 1);
});

test('surviving retry reconciles a closed caller from its original durable close intent', async t => {
  const f = await setup(t, 'lost-close-response');
  await f.run('finish');
  assert.equal((await f.run('finalize')).code, 0);
  const original = (await f.ledger()).find(row => row.effect === 'session.close');
  assert.equal((await f.run('finalize')).code, 0);
  assert.deepEqual((await f.ledger()).find(row => row.effect === 'session.close'), original);
  assert.equal(f.events.filter(e => e === 'session.close').length, 1);
});

test('changed durable result prevents delivery and close', async t => {
  const f = await setup(t);
  await f.run('finish');
  const plan = (await f.store.read('finished')).sessionFinalization;
  await writeFile(plan.resultPath, (await readFile(plan.resultPath, 'utf8')) + 'changed');
  assert.notEqual((await f.run('finalize')).code, 0);
  assert.equal(f.events.includes('session.deliver'), false);
  assert.equal(f.events.includes('session.close'), false);
});

test('definitely failed native close retries remain bounded across public finalizer calls', async t => {
  const f = await setup(t, 'close-failed');
  await f.run('finish');
  assert.equal((await f.run('finalize')).code, 3);
  assert.equal((await f.run('finalize')).code, 3);
  assert.equal(f.events.filter(event => event === 'session.close').length, 2);
});

test('exact pending composer resumes on the original delivery intent and retries are bounded', async t => {
  for (const mode of ['prefilled', 'delivery-failed']) {
    const f = await setup(t, mode);
    await f.run('finish');
    assert.equal((await f.run('finalize')).code, 3);
    const original = (await f.ledger())[0];
    assert.equal((await f.run('finalize')).code, mode === 'prefilled' ? 0 : 3);
    await f.run('finalize');
    assert.equal(f.events.filter(event => event === 'session.deliver').length, 2);
    assert.deepEqual((await f.ledger())[0], original);
    assert.equal((await f.ledger()).filter(row => row.event === 'intent' && row.effect === 'session.deliver').length, 1);
  }
});


test('return obligation survives a tracker outage and public reconciliation cannot bypass it', async t => {
  const f = await setup(t);
  let offline = true;
  f.adapters.tracker = { async read() { if (offline) throw Error('offline'); return null; }, async project() {} };
  await f.store.update('finished', record => ({ ...record, tracker: { adapter: 'test', ref: 'ticket', projected: false } }));
  assert.equal((await f.run('finish')).code, 3);
  assert.ok((await f.store.read('finished')).sessionFinalization);
  offline = false;
  await f.run('reconcile');
  await f.run('close');
  assert.equal((await f.store.read('finished')).state, 'Delivered');
  assert.equal(f.events.includes('session.close'), false);
  assert.equal((await f.run('finalize')).code, 0);
  assert.equal((await f.store.read('finished')).state, 'Closed');
});

test('public finish of a completed goal without a return recipient is refused before any effect', async t => {
  const f = await setup(t);
  const body = JSON.parse(await readFile(path.join(f.root, 'request.json'), 'utf8'));
  delete body.returnTo;
  const request = path.join(f.root, 'no-recipient.json');
  await writeFile(request, JSON.stringify(body));
  const output = await runUnitCli(['unit', 'finish', 'finished', '--request', request], { stateRoot: f.root, adapters: f.adapters });
  const result = JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  assert.equal(result.error, 'RETURN_RECIPIENT_REQUIRED', output);
  assert.equal((await f.store.read('finished')).state, 'Delivered');
  assert.deepEqual(f.events.filter(e => !e.startsWith('observe')), []);
});


test('finalization cleans only the finished receiver watch after result acceptance and verified closure',async t=>{
  const {createWatchStore} = await import('./lib/lifecycle-watch.mjs');
  const {nativeOwner} = await import('./lib/continuity-custody.mjs');
  const f = await setup(t,'queued'); await f.run('finish');
  const owner = nativeOwner((await f.store.read('finished')).sessionFinalization.owner);
  const watches = createWatchStore(f.root,f.adapters);
  await watches.transaction(async(data,save)=>{data.watches=[
    {id:'finished-watch',unit:'finished',recipient:owner,status:'active'},
    {id:'unrelated',unit:'other',recipient:owner,status:'active'},
  ];await save();});
  assert.equal((await f.run('finalize')).code,3);
  assert.equal((await watches.read()).watches[0].status,'active');
  f.accept(); assert.equal((await f.run('finalize')).code,0);
  assert.deepEqual((await watches.read()).watches.map(watch=>watch.status),['removed','active']);
});
