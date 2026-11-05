import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scopeGuard } from './lib/checkpoint.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { amendScope } from './lib/scope-amend.mjs';
import { recheckScope } from './lib/scope-recheck.mjs';

test('a plain scope path covers its directory; similar names and other trees stay outside', () => {
  const guard = (changedPaths, scopePaths) => scopeGuard({ changedPaths, scopePaths, goalClass: 'task' });
  assert.equal(guard(['packages/a/src/x.ts', 'packages/a/src/deep/y.ts'], ['packages/a/src']).ok, true);
  assert.deepEqual(guard(['packages/a/srcx/y.ts', 'packages/b/z.ts'], ['packages/a/src']).finding.paths, ['packages/a/srcx/y.ts', 'packages/b/z.ts']);
  assert.equal(guard(['src/a.ts'], ['src/**']).ok, true);
  assert.equal(guard(['README.md'], ['README.md']).ok, true);
});

test('an approved scope amend adds paths with history, then the recheck resolves the out-of-scope finding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scope-amend-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUnitStateStore(root);
  await store.create({ schema: 'harness.unit/1', unit: 'u1', kind: 'impl', state: 'InReview', policy: { goal: { class: 'task' } }, scopePaths: ['src'],
    findings: [{ kind: 'scope-guard', severity: 'must-fix', paths: ['lib/codes.ts'], resolvedAt: null }], stages: [] });
  const adapters = { now: () => '2026-01-01T00:00:00.000Z', provider: { verifyUserInput: input => ({ ...input, verified: input.userInputRef === 'user-1' }) } };
  const { revision } = await store.read('u1');
  const request = { expectedRevision: revision, add: ['lib/codes.ts'], reason: 'approved decision places error codes in lib' };
  await assert.rejects(amendScope({ store, unit: 'u1', request, userInputRef: 'user-2', adapters }), { code: 'EFFECT_APPROVAL_REQUIRED' });
  await assert.rejects(amendScope({ store, unit: 'u1', request: { ...request, add: ['../outside'] }, userInputRef: 'user-1', adapters }), { code: 'SCOPE_AMEND_INVALID' });
  const result = await amendScope({ store, unit: 'u1', request, userInputRef: 'user-1', adapters });
  assert.deepEqual(result.scopePaths, ['src', 'lib/codes.ts']);
  const amended = await store.read('u1');
  assert.deepEqual(amended.scopeAmendments[0].previous, ['src']);
  await assert.rejects(amendScope({ store, unit: 'u1', request, userInputRef: 'user-1', adapters }), { code: 'STAGE_STALE' });
  const recheck = await recheckScope({ store, unit: 'u1', adapters });
  assert.equal(recheck.resolved.length, 1);
  assert.ok((await store.read('u1')).findings[0].resolvedAt);
});
