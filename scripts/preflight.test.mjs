import test from 'node:test';
import assert from 'node:assert/strict';
import { executePreflighted, preflightRequest } from './lib/preflight.mjs';

test('unsupported operation and protocol are rejected before adapter execution', async () => {
  let calls = 0;
  const result = await executePreflighted({ operation: 'recovery.force', protocol: 'harness.unit/1' }, {
    'recovery.force': async () => { calls += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'UNSUPPORTED_OPERATION');
  assert.equal(calls, 0);

  const protocol = preflightRequest({ operation: 'unit.resume', protocol: 'harness.unit/2' });
  assert.equal(protocol.ok, false);
  assert.equal(protocol.issues[0].code, 'UNSUPPORTED_PROTOCOL');
});

test('unknown policy fields, versions, and sources fail closed', () => {
  const field = preflightRequest({
    operation: 'policy.resolve', protocol: 'harness.policy/1',
    policy: { schema: 'harness.policy/1', experimental: true },
  });
  assert.equal(field.ok, false);
  assert.equal(field.issues[0].code, 'UNSUPPORTED_POLICY_FIELD');

  const version = preflightRequest({
    operation: 'policy.set', protocol: 'harness.policy/1',
    policy: { schema: 'harness.policy/2' },
  });
  assert.equal(version.ok, false);
  assert.ok(version.issues.some(item => item.code === 'UNSUPPORTED_POLICY_VERSION'));

  const source = preflightRequest({
    operation: 'policy.resolve', protocol: 'harness.policy/1',
    policySources: { tenant: { goal: { class: 'task' } } },
  });
  assert.equal(source.ok, false);
  assert.ok(source.issues.some(item => item.code === 'UNSUPPORTED_POLICY_SOURCE'));
});

test('out-of-scope and invalid paths are rejected before adapter execution', async () => {
  let calls = 0;
  const result = await executePreflighted({
    operation: 'unit.resume', protocol: 'harness.unit/1',
    goalClass: 'task', scopePaths: ['src/**'], changedPaths: ['docs/spec.md'],
  }, { 'unit.resume': async () => { calls += 1; } });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'OUT_OF_SCOPE');
  assert.equal(calls, 0);

  const traversal = preflightRequest({
    operation: 'unit.resume', protocol: 'harness.unit/1',
    goalClass: 'task', scopePaths: ['src/**'], changedPaths: ['../secret'],
  });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.issues[0].code, 'INVALID_SCOPE');
});

test('effect authorization rejects before adapter execution', async () => {
  let calls = 0;
  const result = await executePreflighted({
    operation: 'unit.effect', protocol: 'harness.unit/1',
    policySources: { project: { goal: { class: 'task' }, delivery: 'none' } },
    effect: 'git.push', effectContext: {},
  }, { 'unit.effect': async () => { calls += 1; } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(item => item.code === 'EFFECT_DENIED'));
  assert.equal(calls, 0);
});

test('supported preflight delegates exactly once to its registered adapter', async () => {
  let calls = 0;
  const result = await executePreflighted({ operation: 'unit.resume', protocol: 'harness.unit/1' }, {
    'unit.resume': async request => { calls += 1; return request.operation; },
  });
  assert.deepEqual(result, { ok: true, value: 'unit.resume' });
  assert.equal(calls, 1);
});
