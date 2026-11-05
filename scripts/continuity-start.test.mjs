import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {startGoalSession} from './lib/continuity-start.mjs';
import {taskDigest} from './lib/session-task.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('initial launch binds both packets and a retry observes the same session without relaunch', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'continuity-start-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const source = path.join(root,'goal.md'); await writeFile(source,'goal');
  const handoff = path.join(root,'handoff.md'); const packet = ['목표: goal','수용 기준: criteria','작업관리: unit','결정: policy','변경: none','검증: none','남은 일·위험: work','다음 단위 첫 행동: begin'].join('\n'); await writeFile(handoff,packet);
  const goals = createContinuityStore(root), store = createUnitStateStore(root);
  await goals.create({goal:{id:'g1',objective:'goal',criteria:['done'],remaining:['u1'],status:'active'},policy:{runtime:'orca',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest:hash('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u1',kind:'impl',state:'Scoped',continuity:{goalId:'g1'},policy:{goal:{class:'product-prelaunch'}}});
  let launches = 0, receipt;
  const session = {async observe(){return {sessionId:'parent',incarnationId:'v1',cwd:root,runtime:'orca'}}, async execute(input){launches++; const identity={sessionId:'child',incarnationId:'v2',cwd:input.args.cwd}; return receipt = {...identity,task:{...identity,schema:'harness.goal-receipt/1',enforcement:{status:'verified',cwd:root,key:'guard',hash:'hash'},effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:[{path:input.args.handoffPath,digest:input.args.handoffDigest},{path:input.args.goalPath,digest:input.args.goalDigest}]}}}, async verify(){return {status:'completed',result:receipt}}};
  const request = {cwd:root,handoffPath:handoff,handoffDigest:hash(packet),parentRuntime:{sessionId:'parent',incarnationId:'v1',cwd:root}};
  const input = {stateRoot:root,unit:'u1',request,store,adapters:{session,now:()=>new Date().toISOString()}};
  assert.equal((await startGoalSession(input)).status,'completed');
  assert.equal((await startGoalSession(input)).status,'duplicate');
  assert.equal(launches,1);
  const changedPacket = `${packet}\n추가: changed`; await writeFile(handoff,changedPacket);
  await assert.rejects(startGoalSession({...input,request:{...request,handoffDigest:hash(changedPacket)}}),{code:'EFFECT_UNCERTAIN'});
  assert.equal(launches,1);
  assert.equal((await goals.read('g1')).bootstraps[0].unit,'u1');
  await writeFile(source,'changed');
  await assert.rejects(startGoalSession(input),{code:'CONTINUITY_INVALID'});
});

test('independent review inherits the goal without advancing target ownership', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'review-start-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'goal.md');await writeFile(source,'goal');
 const handoff=path.join(root,'handoff.md');const packet=['목표: goal','수용 기준: criteria','작업관리: target','결정: review','변경: source','검증: gates','남은 일·위험: review','다음 단위 첫 행동: inspect'].join('\n');await writeFile(handoff,packet);
 const goals=createContinuityStore(root),store=createUnitStateStore(root);
 await goals.create({goal:{id:'g2',objective:'goal',criteria:['done'],remaining:['target'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex'],roles:{review:{model:'review-model'}}},source:{path:source,digest:hash('goal')}});
 await goals.transaction('g2',current=>({...current,revision:2,bootstraps:[{unit:'target',sessionId:'owner',incarnationId:'owner-1',cwd:root}]}));
 await store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'target',continuity:{goalId:'g2'},policy:{goal:{class:'product-prelaunch'}}});
 let args;
 const session={async observe(){return {sessionId:'owner',incarnationId:'owner-1',cwd:root,runtime:'cmux'}},async execute(input){args=input.args;const identity={sessionId:'reviewer',incarnationId:'reviewer-1',cwd:root};return {...identity,task:{...identity,schema:'harness.goal-receipt/1',enforcement:{status:'verified',cwd:root,key:'guard',hash:'hash'},effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}}},async verify(){return {status:'unknown'}}};
 const request={cwd:root,handoffPath:handoff,handoffDigest:hash(packet),parentRuntime:{sessionId:'owner',incarnationId:'owner-1',cwd:root}};
 assert.equal((await startGoalSession({stateRoot:root,unit:'review',request,store,adapters:{session,now:()=>new Date().toISOString()}})).status,'completed');
 assert.equal(args.role,'review');const goal=await goals.read('g2');assert.deepEqual(goal.goal.remaining,['target']);assert.equal(goal.reviews[0].targetUnit,'target');
});

test('a worker that cannot observe its hooks starts without enforcement; an observed unverified hook is refused', async t => {
  for (const [label, enforcement, expected] of [['claude', undefined, 'completed'], ['codex-unverified', {status:'unverified',provider:'codex',scope:'account-cwd'}, 'rejected']]) await t.test(label, async t => {
    const root = await mkdtemp(path.join(tmpdir(),`goal-start-${label}-`)); t.after(()=>rm(root,{recursive:true,force:true}));
    const source = path.join(root,'goal.md'); await writeFile(source,'goal');
    const handoff = path.join(root,'handoff.md'); const packet = ['목표: goal','수용 기준: criteria','작업관리: unit','결정: policy','변경: none','검증: none','남은 일·위험: work','다음 단위 첫 행동: begin'].join('\n'); await writeFile(handoff,packet);
    const goals = createContinuityStore(root), store = createUnitStateStore(root);
    await goals.create({goal:{id:'g3',objective:'goal',criteria:['done'],remaining:['u1'],status:'active'},policy:{runtime:'cmux',provider:label === 'claude' ? 'claude' : 'codex',account:'/account',model:'model',effort:'high',argv:[label === 'claude' ? 'claude' : 'codex']},source:{path:source,digest:hash('goal')}});
    await store.create({schema:'harness.unit/1',unit:'u1',kind:'impl',state:'Scoped',continuity:{goalId:'g3'},policy:{goal:{class:'product-prelaunch'}}});
    let receipt;
    const session = {async observe(){return {sessionId:'parent',incarnationId:'v1',cwd:root,runtime:'cmux'}}, async execute(input){const identity={sessionId:'child',incarnationId:'v2',cwd:input.args.cwd}; return receipt = {...identity,task:{...identity,schema:'harness.goal-receipt/1',...(enforcement ? {enforcement} : {}),effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:[{path:input.args.handoffPath,digest:input.args.handoffDigest},{path:input.args.goalPath,digest:input.args.goalDigest}]}}}, async verify(){return {status:'completed',result:receipt}}};
    const request = {cwd:root,handoffPath:handoff,handoffDigest:hash(packet),parentRuntime:{sessionId:'parent',incarnationId:'v1',cwd:root}};
    const run = startGoalSession({stateRoot:root,unit:'u1',request,store,adapters:{session,now:()=>new Date().toISOString()}});
    if (expected === 'completed') assert.equal((await run).status,'completed');
    else { const outcome = await run.catch(error => ({status:'rejected', error})); assert.notEqual(outcome.status,'completed'); assert.equal((await goals.read('g3')).bootstraps?.length ?? 0, 0); }
  });
});

test('an uncertain start is re-observed within the call until the receipt verifies, then registered', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'continuity-start-wait-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const source = path.join(root,'goal.md'); await writeFile(source,'goal');
  const handoff = path.join(root,'handoff.md'); const packet = ['목표: goal','수용 기준: criteria','작업관리: unit','결정: policy','변경: none','검증: none','남은 일·위험: work','다음 단위 첫 행동: begin'].join('\n'); await writeFile(handoff,packet);
  const goals = createContinuityStore(root), store = createUnitStateStore(root);
  await goals.create({goal:{id:'g1',objective:'goal',criteria:['done'],remaining:['u1'],status:'active'},policy:{runtime:'orca',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest:hash('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u1',kind:'impl',state:'Scoped',continuity:{goalId:'g1'},policy:{goal:{class:'product-prelaunch'}}});
  let launches = 0, checks = 0, sleeps = 0;
  const receiptFor = input => { const identity={sessionId:'child',incarnationId:'v2',cwd:input.args.cwd}; return {...identity,task:{...identity,schema:'harness.goal-receipt/1',enforcement:{status:'verified',cwd:root,key:'guard',hash:'hash'},effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:[{path:input.args.handoffPath,digest:input.args.handoffDigest},{path:input.args.goalPath,digest:input.args.goalDigest}]}}; };
  const session = {async observe(){return {sessionId:'parent',incarnationId:'v1',cwd:root,runtime:'orca'}},
    async execute(){ launches++; throw Object.assign(new Error('receipt not yet observable'),{taskState:'accepted'}); },
    async verify(input){ checks++; return checks < 3 ? {status:'unknown'} : {status:'completed',result:receiptFor(input)}; }};
  const request = {cwd:root,handoffPath:handoff,handoffDigest:hash(packet),parentRuntime:{sessionId:'parent',incarnationId:'v1',cwd:root}};
  const result = await startGoalSession({stateRoot:root,unit:'u1',request,store,adapters:{session,now:()=>new Date().toISOString(),sleep:async()=>{sleeps++;}}});
  assert.ok(['completed','reconciled','duplicate'].includes(result.status), JSON.stringify(result));
  assert.equal(launches,1); assert.ok(sleeps >= 1);
  assert.equal((await goals.read('g1')).bootstraps[0].sessionId,'child');
});
