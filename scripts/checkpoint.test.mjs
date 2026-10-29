import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeChanges, checkpointRef, createCheckpoint, scopeGuard } from './lib/checkpoint.mjs';

test('checkpoint ref is stable and rejects unsafe identifiers', () => {
  assert.equal(checkpointRef({ unit: 'UNIT-7', stage: 'implement', attempt: 2 }), 'refs/harness/UNIT-7/implement.2');
  assert.throws(() => checkpointRef({ unit: '../other', stage: 'implement', attempt: 1 }), /path-safe/);
  assert.throws(() => checkpointRef({ unit: 'U-1', stage: 'Accepted', attempt: 1 }), /unsupported checkpoint stage/);
});

test('checkpoint creation delegates ignored and excluded paths without changing the worktree or real index', async () => {
  let input;
  const result = await createCheckpoint({
    unit: 'U-1', stage: 'scope', attempt: 1, exclude: ['**/*.pem', '**/*.pem'],
    adapter: { createCheckpoint: async options => { input = options; return { commit: 'abc', worktreeChanged: false, indexChanged: false, excluded: ['secret.pem'] }; } },
  });
  assert.equal(input.respectGitignore, true);
  assert.deepEqual(input.exclude, ['**/*.pem']);
  assert.deepEqual(result, { ref: 'refs/harness/U-1/scope.1', commit: 'abc', excluded: ['secret.pem'] });
  await assert.rejects(createCheckpoint({
    unit: 'U-1', stage: 'scope', attempt: 1,
    adapter: { createCheckpoint: async () => ({ commit: 'abc', worktreeChanged: true, indexChanged: false }) },
  }), /changed the worktree or real index/);
});

test('attribution keeps the first-checkpoint diff and reports shared overlap for both units', () => {
  const result = attributeChanges({
    unit: 'U-1', isolation: 'shared',
    firstCheckpointDiff: ['src/a.mjs', 'src/b.mjs', 'src/reverted.mjs'],
    attemptDiff: ['src/a.mjs'],
    otherUnits: [{ unit: 'U-2', changedPaths: ['src/a.mjs'], checkpointDiff: ['src/c.mjs'] }],
  });
  assert.deepEqual(result.changedPaths, ['src/b.mjs', 'src/reverted.mjs']);
  assert.deepEqual(result.attemptPaths, ['src/a.mjs']);
  assert.deepEqual(result.findings, [{ kind: 'shared-path', severity: 'must-fix', units: ['U-1', 'U-2'], paths: ['src/a.mjs'] }]);
});

test('scope guard selects goal-owned paths and never proposes automatic restoration', () => {
  const task = scopeGuard({ goalClass: 'task', scopePaths: ['src/**'], changedPaths: ['src/a.mjs', 'docs/spec.md'] });
  assert.deepEqual(task, { ok: false, finding: { kind: 'scope-guard', severity: 'must-fix', paths: ['docs/spec.md'], resolvedAt: null } });
  const prelaunch = scopeGuard({ goalClass: 'product-prelaunch', productPaths: ['app/**'], scopePaths: [], changedPaths: ['app/main.mjs'] });
  assert.equal(prelaunch.ok, true);
  assert.equal(prelaunch.finding, null);
});

test('paths escaping the repository are rejected', () => {
  assert.throws(() => scopeGuard({ goalClass: 'task', scopePaths: ['src/**'], changedPaths: ['../outside'] }), /cannot escape/);
});
