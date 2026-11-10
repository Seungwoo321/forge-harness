import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAdapters } from './lib/adapters.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { executionPoliciesEqual, selectExecutionPolicy } from './lib/continuity-decision.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const parse = value => JSON.parse(value.slice(value.lastIndexOf('RESULT ')+7));
const policy = {runtime:'cmux',provider:'codex',account:'/personal',model:'model',effort:'high',argv:['codex']};
async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(),'neutral-policy-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateRoot = path.join(cwd,'state'), goals = createContinuityStore(stateRoot), store = createUnitStateStore(stateRoot);
  const source = {path:path.join(cwd,'goal.md'),digest:`sha256:${createHash('sha256').update('goal').digest('hex')}`};
  await writeFile(source.path,'goal'); await goals.create({goal:{id:'goal',objective:'work',criteria:['done'],remaining:['change'],status:'active'},source,policy});
  const shared = path.join(stateRoot,'policy.json');
  await writeFile(shared,JSON.stringify({goal:{class:'task'},session:{...policy,roles:{review:{effort:'medium'}}}}));
  await store.create({schema:'harness.unit/1',unit:'change',kind:'chore',state:'InReview',continuity:{goalId:'goal'},request:{text:'work'},policy:{session:policy}});
  const adapters = createAdapters({repositoryRoot:cwd});
  const run = async args => parse(await runUnitCli(args,{cwd,stateRoot,adapters}));
  const review = async (name,session) => {
    const request=path.join(cwd,`${name}.json`);await writeFile(request,JSON.stringify({kind:'review',targetUnit:'change',goalId:'goal',request:{text:'review',userInputRef:'original'},policyOverrides:{session}}));
    return run(['unit','start',name,'--request',request,'--project-root',cwd,'--non-interactive']);
  };
  return {cwd,stateRoot,goals,store,shared,run,review};
}

test('AC-1 public review registration accepts empty roles without changing effective settings, goal, target or shared policy',async t => {
  const f=await fixture(t),goal=await f.goals.read('goal'),target=await f.store.read('change'),shared=await readFile(f.shared);
  assert.equal((await f.review('inherited',policy)).error,'CONTINUITY_STALE'); assert.equal(await f.store.read('inherited'),null);
  const result=await f.review('neutral',{...policy,roles:{}}); assert.equal(result.code,0,JSON.stringify(result));
  const review=await f.store.read('neutral'); assert.deepEqual(review.policy.session,{...policy,roles:{}});
  for(const role of ['implementation','review','diagnosis','resolver']) assert.deepEqual(selectExecutionPolicy(review.policy.session,role),selectExecutionPolicy(goal.policy,role));
  assert.deepEqual(await f.goals.read('goal'),goal); assert.deepEqual(await f.store.read('change'),target); assert.deepEqual(await readFile(f.shared),shared);
});

test('AC-1 all real execution differences remain rejected by public review registration',async t => {
  const f=await fixture(t);
  const differences={account:'/other',model:'different',effort:'low',runtime:'orca',provider:'claude',argv:['codex','--different']};
  for (const [field,value] of Object.entries(differences)) {
    const session={...policy,roles:{},[field]:value,...(field==='provider'?{argv:['claude']}:{})};
    assert.equal((await f.review(`different-${field}`,session)).error,'CONTINUITY_STALE');
  }
  for (const role of ['implementation','review','diagnosis','resolver']) {
    assert.equal((await f.review(`different-${role}`,{...policy,roles:{[role]:{effort:'medium'}}})).error,'CONTINUITY_STALE');
  }
});

test('AC-1 neutral refresh is a read-only no-op and neutral goal binding retains original representation',async t => {
  const f=await fixture(t),goal=await f.goals.read('goal');
  await writeFile(f.shared,JSON.stringify({goal:{class:'task'},session:{...policy,roles:{}}}));
  const req=path.join(f.cwd,'refresh.json'); await writeFile(req,JSON.stringify({expectedRevision:goal.revision,reason:'neutral representation'}));
  const refreshed=await f.run(['goal','policy-refresh','goal','--request',req,'--user-input','original','--project-root',f.cwd,'--non-interactive']);
  assert.equal(refreshed.code,0,JSON.stringify(refreshed)); assert.equal(refreshed.summary,'Goal goal execution policy unchanged'); assert.deepEqual(await f.goals.read('goal'),goal);
  await f.store.create({schema:'harness.unit/1',unit:'unbound',kind:'chore',state:'Scoped',policy:{session:{...policy,roles:{}}},request:{text:'work'},stages:[]});
  await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['change','unbound']}}));
  const bind=path.join(f.cwd,'bind.json'); await writeFile(bind,JSON.stringify({goalId:'goal'}));
  const result=await f.run(['unit','goal-bind','unbound','--request',bind]); assert.equal(result.code,0,JSON.stringify(result));
  assert.deepEqual((await f.store.read('unbound')).policy.session,{...policy,roles:{}});
  assert.ok(executionPoliciesEqual(policy,{...policy,roles:{}})); assert.ok(executionPoliciesEqual({...policy,roles:{}},policy));
  assert.ok(!executionPoliciesEqual(policy,{...policy,roles:{review:{effort:'medium'}}}));
});
