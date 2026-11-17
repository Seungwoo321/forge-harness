import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore,executeEffect} from './lib/ledger.mjs';
import {snapshotGoal} from './lib/continuity-snapshot.mjs';
import {effectArgsDigest as digest} from './lib/approvals.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {prepareEffect} from './lib/policy.mjs';
import {recoverExitedReviewFinalization} from './lib/review-exit-recover.mjs';
import {assertReviewsSettled} from './lib/continuity-custody.mjs';
import {prepareGoalFinish} from './lib/continuity-finish.mjs';
import {evaluateAcceptance} from './lib/evidence.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';

const seven=owner=>({runtime:owner.runtime,sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd:owner.cwd,threadId:owner.worker.threadId,pid:owner.worker.pid,executable:owner.worker.executable});
async function fixture(t) {
  const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'review-exit-')));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateRoot=path.join(cwd,'state'),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot),ledger=createLedgerStore(stateRoot);
  const execution={runtime:'cmux',provider:'codex',account:'/original-account',model:'model',effort:'high',argv:['codex']};
  const owner={runtime:'cmux',sessionId:'new-owner',incarnationId:'new-incarnation',cwd,worker:{executable:'/bin/codex',pid:222,threadId:'new-thread',incarnationId:'new-incarnation'}};
  const recipient={...owner,sessionId:'original-owner',incarnationId:'original-source',worker:{executable:'/bin/codex',pid:111,threadId:'original-source-thread',incarnationId:'original-source'}};
  const old={...owner,sessionId:'original-reviewer',incarnationId:'original-review',worker:{executable:'/bin/codex',pid:112,threadId:'original-review-thread',incarnationId:'original-review'}};
  const source=path.join(cwd,'goal.md');await writeFile(source,'goal');
  await goals.create({goal:{id:'goal',objective:'approved work',criteria:['done'],remaining:['change','next'],status:'active'},policy:execution,source:{path:source,digest:taskDigest('goal')}});
  const previous={id:'original-adoption',unit:'change',ownership:'existing',...recipient,owner:recipient,policyDigest:digest(execution)};
  await goals.transaction('goal',g=>({...g,revision:g.revision+1,adoptions:[previous]}));
  const targetGit={head:'new-head',contentFingerprint:'new-content'};
  await store.create({schema:'harness.unit/1',unit:'change',kind:'chore',state:'InReview',continuity:{goalId:'goal'},...targetGit,accepted:null,verdict:null,policy:{goal:{class:'task'},delivery:'none'}});
  const original=await snapshotGoal(stateRoot,await goals.read('goal')),handoffPath=path.join(cwd,'review-handoff.md');await writeFile(handoffPath,'original independent review');
  const startArgs={unit:'review',role:'review',attempt:1,cwd,goalPath:original.path,goalDigest:original.digest,handoffPath,handoffDigest:taskDigest('original independent review'),targetDigest:digest({head:'historical-head'})};
  const startKey=prepareEffect('session.start',startArgs).key;
  await goals.transaction('goal',g=>({...g,revision:g.revision+1,reviews:[{unit:'review',targetUnit:'change',attempt:1,targetDigest:startArgs.targetDigest,nativeThreadId:old.worker.threadId,effectKey:startKey,goalPath:original.path,goalDigest:original.digest,sessionId:old.sessionId,incarnationId:old.incarnationId,cwd}]}));
  const goalSnapshot=await snapshotGoal(stateRoot,await goals.read('goal')),resultPath=path.join(cwd,'original-result.md');await writeFile(resultPath,'real submitted review');
  const legacyOld=structuredClone(old);delete legacyOld.worker.incarnationId;
  const plan={mode:'review',owner:legacyOld,recipient,recipientCustody:previous,resultPath,resultDigest:taskDigest('real submitted review'),handoffPath,handoffDigest:startArgs.handoffDigest,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest};
  const input={unit:'review',targetUnit:'change',stage:'review',attempt:1,inputRevision:1,head:'historical-head',contentFingerprint:'historical-content',data:{acceptance:[]}};
  const stageInput={...input,inputDigest:digest(input)};
  await store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'Closed',targetUnit:'change',continuity:{goalId:'goal'},sessionFinalization:plan,
    stages:[{name:'review',attempts:[{n:1,inputPath:'stages/review.1.input.json',inputDigest:stageInput.inputDigest,endedAt:'earlier',result:'done',outputDigest:digest({status:'done'}),submissionId:'original-review-submission'}]}]});
  await mkdir(path.join(stateRoot,'units/review/stages'));await writeFile(path.join(stateRoot,'units/review/stages/review.1.input.json'),JSON.stringify(stageInput));
  const {worker:originalWorker,...originalSurface}=old;
  const startResult={...originalSurface,executable:originalWorker.executable,pid:originalWorker.pid,task:{schema:'harness.goal-receipt/1',effectKey:startKey,sessionId:old.sessionId,incarnationId:old.incarnationId,cwd,promptDigest:taskDigest('review objective'),threadId:old.worker.threadId,turnId:'turn',activityId:'read',goalDigest:original.digest,goal:{threadId:old.worker.threadId,status:'active',objective:'review objective'},packets:[{path:original.path,digest:original.digest},{path:handoffPath,digest:startArgs.handoffDigest}]}};
  const args={...plan,cwd,session:recipient.sessionId,incarnation:recipient.incarnationId},key=prepareEffect('session.deliver',args).key;
  const rows=[{event:'intent',unit:'review',effect:'session.start',seq:1,key:startKey,args:startArgs},
    {event:'submission',unit:'review',effect:'session.start',seq:1,key:startKey,binding:seven(old)},
    {event:'result',unit:'review',seq:1,key:startKey,result:startResult},
    {event:'intent',unit:'review',effect:'session.deliver',seq:2,key,args}];
  await ledger.withLock('review',async log=>{for(const row of rows)await log.append(row);});
  const provenance=path.join(cwd,'authority.json');await writeFile(provenance,'original authority and exited native evidence');
  const request={id:'recover-original-return',expectedRevision:1,expectedGoalRevision:(await goals.read('goal')).revision,unitDigest:digest(await store.read('review')),goalDigest:digest(await goals.read('goal')),targetDigest:digest(await store.read('change')),ledgerDigest:digest(rows),previousCustodyDigest:digest(previous),owner,provenance:{path:provenance,digest:taskDigest(await readFile(provenance))},reason:'Continue the same approved work after both original native owners exited'};
  let observations=0,hook=async()=>{};
  const adapters={now:()=> 'time',git:{inspectUnit:async()=>({...targetGit})},session:{observe:async({exitedOwner})=>{observations++;assert.ok([old.sessionId,recipient.sessionId].includes(exitedOwner.sessionId));return {...owner,previousOwnerExited:true};},execute:()=>assert.fail('recovery cannot execute external effects')},provider:{
    verifyUserInput:async input=>({...input,verified:true}),
    verifyExitedReviewFinalizationRecovery:async({request,record,target,targetGit,goal,previousCustody,intent,rows,...binding})=>{
      await hook();return {...binding,verified:true,receiverExited:true,recipientExited:true,ownerFenced:true,recipientFenced:true,evidenceDigest:request.provenance.digest,receiver:seven(old),recipient:seven(recipient)};
    }}};
  const inputArgs={stateRoot,store,unit:'review',request,userInputRef:'native:authorized-continuation',adapters,cwd};
  const files=['units/review/unit.json','units/change/unit.json','goals/goal/goal.json'];
  const bytes=()=>Promise.all(files.map(file=>readFile(path.join(stateRoot,file))));
  const refreshLedger=async()=>{request.ledgerDigest=digest(await ledger.withLock('review',log=>log.read()));};
  return {cwd,stateRoot,store,goals,ledger,request,inputArgs,adapters,rows,args,key,owner,recipient,old,targetGit,bytes,refreshLedger,observations:()=>observations,onProof:fn=>{hook=fn;},run:()=>recoverExitedReviewFinalization(inputArgs)};
}

test('public recovery retires only original transport and preserves every original unit/goal/unknown row; replay is exact',async t=>{
  const f=await fixture(t),before=await f.bytes();
  await assert.rejects(assertReviewsSettled({stateRoot:f.stateRoot,store:f.store,goal:await f.goals.read('goal'),unit:'change'}),{code:'CUSTODY_CONFLICT'});
  const requestFile=path.join(f.cwd,'request.json');await writeFile(requestFile,JSON.stringify(f.request));
  const raw=await runUnitCli(['unit','review-exit-recover','review','--request',requestFile,'--user-input',f.inputArgs.userInputRef],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters});
  const result=JSON.parse(raw.slice(raw.lastIndexOf('RESULT ')+7));assert.equal(result.code,0,JSON.stringify(result));
  assert.deepEqual(await f.bytes(),before);assert.equal(f.observations(),4);
  const after=await f.ledger.withLock('review',log=>log.read());assert.deepEqual(after.slice(0,4),f.rows);assert.equal(after.length,5);
  assert.equal(after.at(-1).event,'review-finalization-recovery');assert.equal(after.filter(row=>row.event==='result').length,1);
  assert.equal((await f.run()).duplicate,true);assert.deepEqual(await f.ledger.withLock('review',log=>log.read()),after);
  await assert.rejects(executeEffect({unit:'review',effect:'session.deliver',args:f.args,policy:{goal:{class:'task'},delivery:'none'},context:{explicitUserInstruction:true,productOwned:true},store:f.ledger,adapter:{now:()=> 'time',execute:()=>assert.fail('retired transport replayed'),verify:()=>assert.fail('retired transport was reobserved as completed')}}),{code:'EFFECT_RETIRED'});
});

test('audit stays historical across target progression and formal finish; current review and acceptance remain mandatory',async t=>{
  const f=await fixture(t);await f.run();
  await f.store.update('change',r=>({...r,state:'Accepted',accepted:{head:r.head,contentFingerprint:r.contentFingerprint}}));
  const goal=await f.goals.read('goal'),record=await f.store.read('change');
  await assertReviewsSettled({stateRoot:f.stateRoot,store:f.store,goal,unit:'change'});
  await prepareGoalFinish({stateRoot:f.stateRoot,store:f.store,record,unit:'change',parentRuntime:f.recipient,successor:{approved:true,unit:'next'}});
  const acceptance=evaluateAcceptance({head:record.head,contentFingerprint:record.contentFingerprint,currentHead:record.head,currentContentFingerprint:record.contentFingerprint,reviewRequired:true});
  assert.equal(acceptance.ok,false);assert.equal(acceptance.reason,'matching ship review is required');
  await f.store.create({schema:'harness.unit/1',unit:'current-review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'}});
  await assert.rejects(assertReviewsSettled({stateRoot:f.stateRoot,store:f.store,goal,unit:'change'}),{code:'CUSTODY_CONFLICT'});
});

for(const change of ['stale-goal','stale-review','target','authority','live-reviewer','live-recipient','caller','fence','receiver','false-nonstart','packet','stage','source','registered'])test(`rejects ${change} without a retirement audit`,async t=>{
  const f=await fixture(t),verify=f.adapters.provider.verifyExitedReviewFinalizationRecovery;
  if(change==='stale-goal')f.request.expectedGoalRevision++;
  if(change==='stale-review')f.request.expectedRevision++;
  if(change==='target')f.adapters.git.inspectUnit=async()=>({head:'changed',contentFingerprint:'changed'});
  if(change==='authority')f.adapters.provider.verifyUserInput=async input=>({...input,verified:false});
  if(change==='live-reviewer'||change==='live-recipient'||change==='caller')f.adapters.session.observe=async({exitedOwner})=>({...f.owner,previousOwnerExited:change==='caller'||exitedOwner.sessionId!==(change==='live-reviewer'?f.old:f.recipient).sessionId,...(change==='caller'?{worker:{...f.owner.worker,threadId:'foreign'}}:{})});
  if(['fence','receiver','false-nonstart'].includes(change))f.adapters.provider.verifyExitedReviewFinalizationRecovery=async input=>({...await verify(input),...(change==='fence'?{recipientFenced:false}:change==='receiver'?{receiver:seven(f.recipient)}:{taskNeverStarted:true})});
  if(change==='packet')f.onProof(()=>writeFile(path.join(f.cwd,'original-result.md'),'changed'));
  if(change==='stage')f.onProof(()=>writeFile(path.join(f.stateRoot,'units/review/stages/review.1.input.json'),'{}'));
  if(change==='source')f.onProof(()=>writeFile(path.join(f.cwd,'goal.md'),'changed'));
  if(change==='registered')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,reviews:[{...g.reviews[0],nativeThreadId:'foreign'}]}));
  await assert.rejects(f.run());assert.deepEqual(await f.ledger.withLock('review',log=>log.read()),f.rows);
});

for(const event of ['submission','result','extra-intent','close-intent'])test(`refuses ${event} on original return history`,async t=>{
  const f=await fixture(t);
  await f.ledger.withLock('review',log=>log.append(event==='extra-intent'||event==='close-intent'?{event:'intent',unit:'review',seq:3,key:'another',effect:event==='close-intent'?'session.close':'session.deliver',args:{}}:{event,unit:'review',seq:2,key:f.key,...(event==='result'?{result:{status:'unknown'}}:{binding:{}})}));
  await f.refreshLedger();const before=await f.ledger.withLock('review',log=>log.read());
  await assert.rejects(f.run());assert.deepEqual(await f.ledger.withLock('review',log=>log.read()),before);
});

test('concurrent exact recoveries append only one audit; changed replay is rejected',async t=>{
  const f=await fixture(t),results=await Promise.all([f.run(),f.run()]);
  assert.equal(results.filter(row=>row.duplicate).length,1);
  assert.equal((await f.ledger.withLock('review',log=>log.read())).filter(row=>row.event==='review-finalization-recovery').length,1);
  f.request.reason='different';await assert.rejects(f.run());
});


test('historical packet drift after retirement blocks both custody and formal finish',async t=>{
  const f=await fixture(t);await f.run();await writeFile(path.join(f.cwd,'original-result.md'),'changed');
  const goal=await f.goals.read('goal');
  await assert.rejects(assertReviewsSettled({stateRoot:f.stateRoot,store:f.store,goal,unit:'change'}),{code:'CUSTODY_CONFLICT'});
  await assert.rejects(prepareGoalFinish({stateRoot:f.stateRoot,store:f.store,record:await f.store.read('change'),unit:'change',parentRuntime:f.recipient,successor:{approved:true,unit:'next'}}),{code:'SESSION_CLOSE_PENDING'});
});


for(const field of ['goalPath','handoffDigest','recipientCustody','session'])test(`complete original return args reject changed ${field}`,async t=>{
  const f=await fixture(t),file=path.join(f.stateRoot,'units/review/ledger.ndjson');
  const rows=structuredClone(f.rows);rows.at(-1).args[field]=field==='recipientCustody'?{}:'different';
  rows.at(-1).key=prepareEffect('session.deliver',rows.at(-1).args).key;
  await writeFile(file,rows.map(row=>JSON.stringify(row)+'\n').join(''));await f.refreshLedger();
  await assert.rejects(f.run());assert.deepEqual(await f.ledger.withLock('review',log=>log.read()),rows);
});

for(const field of ['receiver','recipient','gitTargetDigest'])test(`post-audit ${field} tamper cannot satisfy custody or formal finish`,async t=>{
  const f=await fixture(t);await f.run();const file=path.join(f.stateRoot,'units/review/ledger.ndjson');
  const rows=await f.ledger.withLock('review',log=>log.read());
  if(field==='gitTargetDigest')rows.at(-1).proof[field]='sha256:'+'0'.repeat(64);else delete rows.at(-1).proof[field];
  await writeFile(file,rows.map(row=>JSON.stringify(row)+'\n').join(''));
  const goal=await f.goals.read('goal');
  await assert.rejects(assertReviewsSettled({stateRoot:f.stateRoot,store:f.store,goal,unit:'change'}),{code:'CUSTODY_CONFLICT'});
  await assert.rejects(prepareGoalFinish({stateRoot:f.stateRoot,store:f.store,record:await f.store.read('change'),unit:'change',parentRuntime:f.recipient,successor:{approved:true,unit:'next'}}),{code:'SESSION_CLOSE_PENDING'});
});

test('loss of either unit custody guard refuses audit append',async t=>{
  for(const lost of ['review','change']) {
    const f=await fixture(t),actual=f.store;
    f.inputArgs.store={...actual,withLock:(id,action,...options)=>actual.withLock(id,(record,assertHeld)=>action(record,()=>{
      assertHeld();if(id===lost)throw Object.assign(new Error('lost native guard'),{code:'GOAL_LOCK_UNAVAILABLE'});
    }),...options)};
    await assert.rejects(f.run(),{code:'GOAL_LOCK_UNAVAILABLE'});
    assert.deepEqual(await f.ledger.withLock('review',log=>log.read()),f.rows);
  }
});


test('legacy nested startup worker and native task thread remain exactly bound',async t=>{
  const f=await fixture(t),file=path.join(f.stateRoot,'units/review/ledger.ndjson');
  const rows=structuredClone(f.rows);rows[2].result.worker=f.old.worker;
  await writeFile(file,rows.map(row=>JSON.stringify(row)+'\n').join(''));await f.refreshLedger();
  assert.equal((await f.run()).mode,'exited-review-finalization');
});
