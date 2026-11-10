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

test('AC-2 original human scope correction preserves the rejected amendment and every prior field',async t=>{
  const {correctScopeApproval}=await import('./lib/scope-amend.mjs');const {effectArgsDigest}=await import('./lib/approvals.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'scope-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=createUnitStateStore(root);
  const original={previous:['src'],added:['lib'],reason:'operator-driven recovery',userInputRef:'operator-not-human'};
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Implementing',policy:{goal:{class:'task'}},scopePaths:['src','lib'],scopeAmendments:[original],stages:[],failures:[{id:'original-failure'}],evidence:[{gate:'tests',status:'failed'}]});
  const before=await store.read('u');const request={id:'correct-1',expectedRevision:before.revision,amendment:{index:0,digest:effectArgsDigest(original)},reason:'Original human continuation after the documented blocker'};
  const target={head:'head',contentFingerprint:'content'};let authorized=false;
  const adapters={now:()=> '2026-01-01T00:00:00Z',git:{inspectUnit:async()=>target},provider:{verifyUserInput:async binding=>({...binding,verified:authorized && binding.userInputRef==='original-human' && binding.previousUserInputRef===original.userInputRef})}};
  const run=(patch={})=>correctScopeApproval({stateRoot:root,store,unit:'u',request,userInputRef:'original-human',adapters,...patch});
  await assert.rejects(run(),{code:'EFFECT_APPROVAL_REQUIRED'});assert.deepEqual(await store.read('u'),before);
  await assert.rejects(run({userInputRef:original.userInputRef}));assert.deepEqual(await store.read('u'),before);
  authorized=true;const results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x.duplicate).length,1);
  const after=await store.read('u');assert.deepEqual({...after,revision:before.revision,scopeApprovalCorrections:undefined},{...before,scopeApprovalCorrections:undefined});
  assert.deepEqual(after.scopeAmendments,[original]);assert.equal(after.scopeApprovalCorrections.length,1);assert.equal(after.scopeApprovalCorrections[0].userInputRef,'original-human');
  await assert.rejects(run({request:{...request,reason:'different'}}));assert.deepEqual(await store.read('u'),after);
});

test('scope approval correction refuses target drift and stale amendment digests without a partial receipt',async t=>{
  const {correctScopeApproval}=await import('./lib/scope-amend.mjs');const {effectArgsDigest}=await import('./lib/approvals.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'scope-authority-drift-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=createUnitStateStore(root);
  const original={previous:['src'],added:['lib'],reason:'operator',userInputRef:'operator'};await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Implementing',policy:{goal:{class:'task'}},scopePaths:['src','lib'],scopeAmendments:[original],stages:[]});
  const before=await store.read('u'),request={id:'c',expectedRevision:1,amendment:{index:0,digest:effectArgsDigest(original)},reason:'source-backed correction'};let calls=0;
  const adapters={now:()=>'',git:{inspectUnit:async()=>({head:'head',contentFingerprint:++calls===1?'original':'drift'})},provider:{verifyUserInput:async binding=>({...binding,verified:true})}};
  await assert.rejects(correctScopeApproval({stateRoot:root,store,unit:'u',request,userInputRef:'human',adapters}),{code:'STAGE_STALE'});assert.deepEqual(await store.read('u'),before);
  const changed={...request,amendment:{...request.amendment,digest:effectArgsDigest('wrong')}};
  await assert.rejects(correctScopeApproval({stateRoot:root,store,unit:'u',request:changed,userInputRef:'human',adapters}));assert.deepEqual(await store.read('u'),before);
});
