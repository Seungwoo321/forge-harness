import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore,sessionEffectRetired} from './lib/ledger.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {recoverGoalCompletion} from './lib/completion-recover.mjs';
import {prepareEffect} from './lib/policy.mjs';

async function fixture(t,{intent=true,state='Delivered'}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'completion-recovery-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createUnitStateStore(root),goals=createContinuityStore(root),ledger=createLedgerStore(root);
  const file=path.join(root,'source'),bytes='proof';await writeFile(file,bytes);
  const source={path:file,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
  await goals.create({goal:{id:'g',objective:'goal',criteria:['before'],remaining:['u'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source});
  const accepted={head:'old',contentFingerprint:'old-tree'},completion={goalId:'g',revision:1,proof:[]},plan={owner:{sessionId:'owner',incarnationId:'old',cwd:root},resultDigest:'result'};
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state,continuity:{goalId:'g'},accepted:state==='Delivered'?accepted:null,
    deliveryResult:{level:'push',head:'old'},sessionFinalization:plan,goalCompletion:completion,acceptance:[{id:'AC-1',text:'before'}],
    evidence:[{gate:'tests',status:'passed',covers:['AC-1']}],reviewDecision:{verdict:'ship'},stages:[]});
  const reservation={unit:'u',goalRevision:1,completionDigest:effectArgsDigest(completion),planDigest:effectArgsDigest(plan),acceptedDigest:effectArgsDigest(accepted),accepted};
  await goals.transaction('g',g=>({...g,revision:g.revision+1,completionReservation:reservation}));
  const args={session:'owner',incarnation:'old'};
  const close=intent?{event:'intent',effect:'session.close',seq:3,key:prepareEffect('session.close',args).key,args}:null;
  if(close) await ledger.withLock('u',l=>l.append(close));
  const target={head:'new',contentFingerprint:'new-tree'};
  const request={id:'recover',expectedRevision:1,expectedGoalRevision:2,reservationDigest:effectArgsDigest(reservation),targetDigest:effectArgsDigest(target),provenance:source,reason:'target changed'};
  const adapters={now:()=> 'time',git:{inspectUnit:async()=>target},provider:{verifyUserInput:async x=>({...x,verified:true}),
    verifyGoalCompletionRecovery:async x=>({...x,verified:true,closeNotApplied:true,oldExecutionFenced:true,ownerAlive:true,queueSettled:true,owner:x.record.sessionFinalization.owner,evidenceDigest:source.digest})}};
  const run=(changes={})=>recoverGoalCompletion({stateRoot:root,store,unit:'u',request,userInputRef:'approved-user',adapters,...changes});
  return {root,store,goals,ledger,close,request,adapters,run};
}

test('completion recovery preserves delivery history and retires the exact non-applied close',async t=>{
  const f=await fixture(t); const receipt=await f.run(); const record=await f.store.read('u');
  assert.equal(record.state,'SelfGated'); assert.equal(record.accepted,null); assert.equal(record.deliveryResult,null);
  assert.equal(record.completionRecoveries[0].prior.accepted.head,'old');
  assert.equal(record.completionRecoveries[0].prior.deliveryResult.level,'push');
  assert.equal(record.evidence[0].status,'stale'); assert.equal((await f.goals.read('g')).completionReservation,undefined);
  const rows=await f.ledger.withLock('u',l=>l.read()); assert.equal(sessionEffectRetired(rows,f.close),true);
  assert.equal(receipt.seq,3); assert.equal((await f.run()).duplicate,true);
});

test('completion recovery fails closed without every bound host proof',async t=>{
  for(const field of ['closeNotApplied','oldExecutionFenced','ownerAlive','queueSettled','owner']) {
    const f=await fixture(t), original=f.adapters.provider.verifyGoalCompletionRecovery;
    f.adapters.provider.verifyGoalCompletionRecovery=async x=>({...await original(x),[field]:false});
    await assert.rejects(f.run(),{code:'COMPLETION_RECOVERY_UNPROVEN'});
    assert.ok((await f.goals.read('g')).completionReservation); assert.equal((await f.store.read('u')).state,'Delivered');
  }
});

test('completion recovery rejects an applied close and a stale target',async t=>{
  const f=await fixture(t); await f.ledger.withLock('u',l=>l.append({event:'result',seq:f.close.seq,key:f.close.key,result:{status:'completed',result:{closed:true}}}));
  await assert.rejects(f.run(),{code:'EFFECT_UNCERTAIN'});
  const g=await fixture(t); g.adapters.git.inspectUnit=async()=>({head:'changed'});
  await assert.rejects(g.run(),{code:'CONTINUITY_STALE'});
});

test('completion recovery resumes the same receipt after goal commit and unit write interruption',async t=>{
  const f=await fixture(t,{state:'SelfGated',intent:false});
  const broken={...f.store,update:async(unit,mutate)=>f.store.withLock(unit,async record=>{await mutate(record);throw new Error('disk fault');})};
  await assert.rejects(f.run({store:broken}),/disk fault/);
  assert.equal((await f.goals.read('g')).completionReservation,undefined);
  assert.equal((await f.store.read('u')).completionRecoveries,undefined);
  f.adapters.git.inspectUnit=async()=>({head:'later',contentFingerprint:'later-tree'});
  delete f.adapters.provider.verifyGoalCompletionRecovery;
  delete f.adapters.provider.verifyUserInput;
  await f.run();
  assert.equal((await f.store.read('u')).completionRecoveries[0].prior.accepted.head,'old');
  assert.equal((await f.ledger.withLock('u',l=>l.read())).filter(row=>row.event==='goal-completion-recovery').length,1);
});

test('completion recovery rechecks the original close after a durable checkpoint',async t=>{
  const f=await fixture(t); const record=await f.store.read('u');
  const requestDigest=effectArgsDigest({request:f.request,userInputRef:'approved-user'});
  const goal=await f.goals.read('g'),target=await f.adapters.git.inspectUnit();
  const binding={unit:'u',goalId:'g',userInputRef:'approved-user',argsDigest:requestDigest,unitDigest:effectArgsDigest(record),
    goalDigest:effectArgsDigest(goal),reservationDigest:f.request.reservationDigest,targetDigest:f.request.targetDigest,
    intentDigest:effectArgsDigest(f.close),resultDigest:effectArgsDigest(null),provenanceDigest:f.request.provenance.digest};
  const proof={...binding,verified:true,closeNotApplied:true,oldExecutionFenced:true,ownerAlive:true,queueSettled:true,
    owner:record.sessionFinalization.owner,evidenceDigest:f.request.provenance.digest};
  const checkpoint={event:'goal-completion-recovery',unit:'u',id:f.request.id,seq:f.close.seq,key:f.close.key,
    intentDigest:effectArgsDigest(f.close),request:f.request,requestDigest,userInputRef:'approved-user',unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),target,proof,at:'time'};
  await f.ledger.withLock('u',l=>l.append(checkpoint));
  f.adapters.git.inspectUnit=async()=>({head:'later',contentFingerprint:'later-tree'});
  f.adapters.provider.verifyGoalCompletionRecovery=async()=>{throw new Error('checkpoint must not resubmit proof');};
  await f.run();
  assert.equal((await f.ledger.withLock('u',l=>l.read())).filter(row=>row.event==='goal-completion-recovery').length,1);
});

test('public completion recovery command records the same audited receipt',async t=>{
  const f=await fixture(t);
  const requestFile=path.join(f.root,'request.json'); await writeFile(requestFile,JSON.stringify(f.request));
  const {runUnitCli}=await import('./lib/unit-driver.mjs');
  const output=await runUnitCli(['unit','completion-recover','u','--request',requestFile,'--user-input','approved-user'],{stateRoot:f.root,cwd:f.root,adapters:f.adapters});
  assert.match(output,/RESULT \{"code":0/);
  assert.equal((await f.store.read('u')).completionRecoveries[0].id,'recover');
});

test('completion recovery refuses another effect with uncertain result',async t=>{
  const f=await fixture(t);
  const other={event:'intent',effect:'git.push',seq:4,key:'sha256:'+'b'.repeat(64),args:{}};
  await f.ledger.withLock('u',async l=>{await l.append(other);await l.append({event:'result',seq:4,key:other.key,result:{status:'uncertain'}});});
  await assert.rejects(f.run(),{code:'EFFECT_UNCERTAIN'});
  assert.ok((await f.goals.read('g')).completionReservation);
});

test('completion recovery requires the actual approval and trusted provider',async t=>{
  const f=await fixture(t); f.adapters.provider.verifyUserInput=async x=>({...x,verified:false});
  await assert.rejects(f.run(),{code:'EFFECT_APPROVAL_REQUIRED'});
  assert.ok((await f.goals.read('g')).completionReservation);
  const g=await fixture(t); delete g.adapters.provider.verifyGoalCompletionRecovery;
  await assert.rejects(g.run(),{code:'ADAPTER_MISSING'});
  assert.equal((await g.store.read('u')).state,'Delivered');
});

test('completion recovery refuses a close receipt even if its status is uncertain',async t=>{
  const f=await fixture(t);
  await f.ledger.withLock('u',l=>l.append({event:'result',seq:f.close.seq,key:f.close.key,result:{status:'unknown',result:{closed:true}}}));
  await assert.rejects(f.run(),{code:'EFFECT_UNCERTAIN'});
  assert.ok((await f.goals.read('g')).completionReservation);
});
