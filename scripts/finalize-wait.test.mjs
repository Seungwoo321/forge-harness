import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeWithin } from './lib/finalize-wait.mjs';

test('a pending finalization is re-observed within its bound and stops once delivered', async () => {
  let clock = 0; const sleeps = [];
  const results = [{ code: 3, finalizePending: true }, { code: 3, finalizePending: true }, { code: 0, state: 'Closed' }];
  const out = await finalizeWithin(async () => results.shift(), { waitSeconds: 300, intervalSeconds: 30, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.equal(out.code, 0); assert.equal(out.attempts, 3); assert.deepEqual(sleeps, [30000, 30000]);
});

test('without a wait bound or after the bound, the pending result is returned unchanged', async () => {
  let calls = 0; const pending = async () => { calls += 1; return { code: 3, finalizePending: true }; };
  assert.equal((await finalizeWithin(pending)).attempts, 1);
  let clock = 0; calls = 0;
  const out = await finalizeWithin(pending, { waitSeconds: 60, intervalSeconds: 30, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(out.finalizePending, true); assert.equal(calls, 3);
  await assert.rejects(finalizeWithin(pending, { waitSeconds: -1 }), TypeError);
});
