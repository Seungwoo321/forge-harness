import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeEffect,
  effectDefinition,
  prepareEffect,
  resolvePolicy,
} from './lib/policy.mjs';

test('policy resolves fields by precedence and records each source', () => {
  const result = resolvePolicy({
    global: { goal: { class: 'product-live' }, delivery: 'push', retry: { maxResolver: 4 } },
    workspace: { goal: { defaults: [{ match: { cwd: '/work/**' }, class: 'product-prelaunch' }] }, delivery: 'pr' },
    project: { goal: { class: 'task' }, delivery: 'commit' },
    unit: { retry: { maxPerSignature: 3 } },
    user: { delivery: 'none' },
  }, { projectRoot: '/work/app' });

  assert.equal(result.policy.goal.class, 'task');
  assert.equal(result.policy.delivery, 'none');
  assert.equal(result.policy.retry.maxPerSignature, 3);
  assert.equal(result.policy.retry.maxResolver, 4);
  assert.deepEqual(result.policySources, {
    'goal.class': 'project',
    'delivery': 'user',
    'retry.maxPerSignature': 'unit',
    'retry.maxResolver': 'global',
  });
});

test('same-level class wins, while a matching workspace default wins over global class', () => {
  const sameLevel = resolvePolicy({
    workspace: {
      goal: {
        class: 'task',
        defaults: [{ match: { cwd: '/work/**' }, class: 'product-live' }],
      },
    },
  }, { projectRoot: '/work/app' });
  assert.equal(sameLevel.policy.goal.class, 'task');

  const workspaceDefault = resolvePolicy({
    global: { goal: { class: 'product-live' } },
    workspace: { goal: { defaults: [{ match: { cwd: '/work/**' }, class: 'product-prelaunch' }] } },
  }, { projectRoot: '/work/app' });
  assert.equal(workspaceDefault.policy.goal.class, 'product-prelaunch');
  assert.equal(workspaceDefault.policySources['goal.class'], 'workspace');
});

test('goal.class absence blocks interactive runs and sets the conservative non-interactive default', () => {
  assert.throws(() => resolvePolicy(), error => error.code === 'POLICY_UNSET' && error.exitCode === 3);
  const result = resolvePolicy({}, { nonInteractive: true });
  assert.equal(result.policy.goal.class, 'task');
  assert.equal(result.policySources['goal.class'], 'unconfirmed-default');
});

test('delivery and retry defaults are stable, with class-specific review defaults', () => {
  const result = resolvePolicy({ project: { goal: { class: 'product-live' } } });
  assert.equal(result.policy.delivery, 'none');
  assert.deepEqual(result.policy.retry, { maxPerSignature: 2, maxResolver: 2 });
  assert.deepEqual(result.policy.review, {
    mode: 'conditional',
    by: 'session',
    triggers: ['risk-kind', 'out-of-scope', 'unproven-gate', 'repeated-signature'],
  });
});

test('deny and invariant boundaries override authority allow', () => {
  const policy = {
    goal: { class: 'task' },
    delivery: 'merge',
    authority: { allow: ['git.push'], deny: ['git.push'] },
  };
  assert.equal(authorizeEffect(policy, 'git.push', { explicitUserInstruction: true }).allowed, false);
  assert.equal(authorizeEffect({ ...policy, authority: { allow: ['E2'], deny: [] } }, 'git.commit', { inScope: true, resourceOwned: false }).allowed, false);
  assert.equal(authorizeEffect({ ...policy, authority: { allow: ['E2'], deny: [] } }, 'git.commit', { inScope: true, containsSecret: true }).allowed, false);
});

test('effect registry determines the canonical key and rejects caller overrides', () => {
  assert.deepEqual(effectDefinition('pr.create'), {
    class: 'E3',
    keyFields: ['repo', 'branch', 'head', 'base'],
    delivery: 'pr',
  });
  const first = prepareEffect('pr.create', { base: 'main', head: 'abc', branch: 'feat/x', repo: 'org/app' });
  const second = prepareEffect('pr.create', { repo: 'org/app', branch: 'feat/x', head: 'abc', base: 'main' });
  assert.deepEqual(first, second);
  assert.throws(() => prepareEffect('pr.create', { repo: 'org/app' }), /missing effect key field/);
  assert.throws(() => prepareEffect('pr.create', {}, { class: 'E0' }), /cannot override/);
  assert.throws(() => effectDefinition('unknown.effect'), error => error.code === 'EFFECT_UNREGISTERED');
});

test('delivery level caps shared effects', () => {
  const policy = { goal: { class: 'product-prelaunch' }, delivery: 'push' };
  assert.deepEqual(authorizeEffect(policy, 'git.push', { productOwned: true }), {
    allowed: true,
    reason: 'policy allows effect',
  });
  assert.equal(authorizeEffect({ ...policy, delivery: 'none' }, 'git.push', { productOwned: true }).allowed, false);
});

test('commit delivery cap and irreversible escalation cannot be bypassed by ordinary class grants', () => {
  const policy = { goal: { class: 'task' }, delivery: 'merge', authority: { allow: ['E3'], deny: [] } };
  assert.equal(authorizeEffect({ ...policy, delivery: 'none', authority: { allow: ['E2'], deny: [] } }, 'git.commit', { inScope: true }).allowed, false);
  assert.equal(authorizeEffect(policy, 'pr.merge', { irreversible: true, explicitUserInstruction: true }).allowed, false);
  assert.equal(authorizeEffect({ ...policy, authority: { allow: ['E4'], deny: ['E3'] } }, 'pr.merge', { irreversible: true }).allowed, false);
});
