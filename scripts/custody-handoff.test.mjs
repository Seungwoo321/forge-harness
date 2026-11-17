import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAdapters} from './lib/adapters.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {effectArgsDigest as digest} from './lib/approvals.mjs';
import {goalOwner} from './lib/continuity-custody.mjs';
import {snapshotGoal} from './lib/continuity-snapshot.mjs';
import {prepareEffect} from './lib/policy.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {loadManagedLaunch} from './lib/continuity-launch-io.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';
const hash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
async function fixture(t){
 const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'handoff-')));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const stateRoot=path.join(cwd,'state'),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot),ledger=createLedgerStore(stateRoot);
 const source={path:path.join(cwd,'source.md'),digest:hash('original')};await writeFile(source.path,'original');
 const policy={runtime:'cmux',provider:'claude',account:'/old-account',model:'model',effort:'high',argv:['claude']};
 const owner={runtime:'cmux',sessionId:'old',incarnationId:'old-v1',cwd,worker:{executable:'/bin/claude',pid:42,incarnationId:'old-v1',threadId:'old-thread'}};
 const replacement={...owner,sessionId:'new',incarnationId:'new-v1',worker:{executable:'/bin/codex',pid:43,incarnationId:'new-v1',threadId:'new-thread'}};
 const nextPolicy={...policy,provider:'codex',account:'/new-account',argv:['codex']};
 const target={head:'head',contentFingerprint:'tree'};
 await store.create({schema:'harness.unit/1',unit:'change',kind:'impl',state:'InReview',continuity:{goalId:'goal'},head:'head',contentFingerprint:'tree',canon:[source],failures:[{signature:'original-failure'}],evidence:[{status:'passed'}],policy:{session:policy,review:{mode:'required',by:'session'}},accepted:null});
 const previous={id:'original',unit:'change',ownership:'existing',...owner,owner,policyDigest:digest(policy),goalRevision:2};
 await goals.create({goal:{id:'goal',objective:'original',criteria:['original'],remaining:['change'],status:'active'},source,policy,adoptions:[previous]});
 await goals.transaction('goal',g=>({...g,revision:g.revision+1,adoptions:[previous]}));
 const proof=path.join(cwd,'proof.json');await writeFile(proof,'sourced original handoff authorization');
 const request={id:'handoff-1',expectedRevision:(await store.read('change')).revision,expectedGoalRevision:(await goals.read('goal')).revision,
 unitDigest:digest(await store.read('change')),goalDigest:digest(await goals.read('goal')),targetDigest:digest(target),previousCustodyDigest:digest(previous),owner:replacement,policy:nextPolicy,provenance:{ref:proof,digest:hash(await readFile(proof))},reason:'Explicitly approved suspended owner handoff'};
 let suspended=true,live=replacement,permission=true,hook=async()=>{};
 const adapters={...createAdapters({repositoryRoot:cwd}),git:{inspectUnit:async()=>({...target})},session:{observe:async input=>{assert.deepEqual(input.suspendedOwner,owner);return {...live,previousOwnerSuspended:suspended};}},provider:{verifyUserInput:async input=>({...input,verified:permission && input.effect==='unit.session.handoff' && input.userInputRef==='human'}),verifySessionHandoff:async input=>{const {request,record,goal,target,previousCustody,...binding}=input;assert.deepEqual(previousCustody,previous);assert.equal(binding.previousPolicyDigest,digest(policy));await hook();return {...binding,verified:permission};}}};
 const run=async(body=request,fileName='request.json',route='session-handoff')=>{const file=path.join(cwd,fileName);await writeFile(file,JSON.stringify(body));const out=await runUnitCli(['unit',route,'change','--request',file,'--user-input','human'],{cwd,stateRoot,adapters});return JSON.parse(out.slice(out.lastIndexOf('RESULT ')+7));};
 return {cwd,stateRoot,store,goals,ledger,source,proof,request,run,target,adapters,replacement,nextPolicy,previous,unsuspend:()=>{suspended=false;},wrongOwner:()=>{live={...replacement,worker:{...replacement.worker,threadId:'foreign'}};},deny:()=>{permission=false;},hook:fn=>{hook=fn;}};
}
test('AC-1 public cross-provider handoff preserves source unit and custody and replays without effects',async t=>{
 const f=await fixture(t),unit=await readFile(path.join(f.stateRoot,'units/change/unit.json')),before=await f.goals.read('goal');
 const result=await f.run();assert.equal(result.code,0,JSON.stringify(result));const after=await f.goals.read('goal');
 assert.deepEqual(await readFile(path.join(f.stateRoot,'units/change/unit.json')),unit);assert.deepEqual(after.adoptions,before.adoptions);assert.deepEqual(after.policy,f.nextPolicy);assert.deepEqual(goalOwner(after,'change').owner,f.replacement);assert.equal(after.handovers.length,1);
 const replay=await f.run();assert.equal(replay.code,0,JSON.stringify(replay));assert.equal(replay.receipt.duplicate,true);assert.deepEqual(await f.goals.read('goal'),after);
 assert.notEqual((await f.run({...f.request,reason:'changed request'})).code,0);
});
test('AC-2 stale authority, unfenced owners and active effects/review never transfer custody',async t=>{
 const cases={
  staleUnit:f=>{f.request.expectedRevision++;},staleGoal:f=>{f.request.expectedGoalRevision++;},wrongCustody:f=>{f.request.previousCustodyDigest=hash('foreign');},
  changedTarget:f=>{f.target.head='other';},unsuspended:f=>f.unsuspend(),wrongNative:f=>f.wrongOwner(),denied:f=>f.deny(),missingVerifier:f=>{delete f.adapters.provider.verifySessionHandoff;},
  wrongPolicy:f=>{f.request.policy.provider='claude';},sameSurface:f=>{f.request.owner.sessionId='old';},sameThread:f=>{f.request.owner.worker.threadId='old-thread';},
  changedSource:f=>writeFile(f.source.path,'other'),changedProof:f=>writeFile(f.proof,'forged'),
  targetRace:f=>f.hook(()=>{f.target.head='other';}),nativeRace:f=>f.hook(()=>f.wrongOwner()),suspensionRace:f=>f.hook(()=>f.unsuspend()),sourceRace:f=>f.hook(()=>writeFile(f.source.path,'other')),
  uncertain:f=>f.ledger.withLock('change',log=>log.append({event:'intent',seq:1,key:'unsettled',effect:'session.start'})),
  ...Object.fromEntries(['pending','running','unknown','uncertain',null].map(status=>[`effect-${status}`,f=>f.ledger.withLock('change',async log=>{await log.append({event:'intent',seq:1,key:'pending',effect:'git.push'});await log.append({event:'result',seq:1,key:'pending',result:status===null?null:{status}});})])),
  activeReview:f=>f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'}})
 };
 for(const [name,alter] of Object.entries(cases))await t.test(name,async t=>{const f=await fixture(t);await alter(f);const before=await f.goals.read('goal'),unit=await f.store.read('change');const result=await f.run();assert.notEqual(result.code,0,JSON.stringify(result));assert.deepEqual(await f.goals.read('goal'),before);assert.deepEqual(await f.store.read('change'),unit);});
});
test('AC-3 concurrent competing handoffs commit once and later restart custody supersedes handoff',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.run({...f.request,id:'candidate-a'},'candidate-a.json'),f.run({...f.request,id:'candidate-b'},'candidate-b.json')]);assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));assert.equal((await f.goals.read('goal')).handovers.length,1);
 const g=await f.goals.read('goal'),later={...g.handovers[0],id:'restart',goalRevision:g.revision+1};assert.equal(goalOwner({...g,rebindings:[later]},'change').id,'restart');
});

async function suspendedReviewerFixture(t){
 const f=await fixture(t),goal=await f.goals.read('goal'),target=await f.store.read('change');
 const packet=['목표: goal','수용 기준: original','작업관리: review','결정: approved','변경: inspect','검증: pending','남은 일·위험: review','다음 단위 첫 행동: read'].join('\n');
 const handoffPath=path.join(f.cwd,'review.md');await writeFile(handoffPath,packet);
 await f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'},stages:[],policy:{goal:{class:'task'},session:goal.policy}});
 const snapshot=await snapshotGoal(f.stateRoot,goal),args={unit:'review',role:'review',attempt:1,cwd:f.cwd,handoffPath,handoffDigest:taskDigest(packet),goalPath:snapshot.path,goalDigest:snapshot.digest,targetDigest:digest(target)};
 const key=prepareEffect('session.start',args).key,intent={event:'intent',unit:'review',seq:1,key,effect:'session.start',args};
 const reviewOwner={...f.previous.owner,sessionId:'old-review',incarnationId:'review-v1',worker:{...f.previous.owner.worker,pid:44,incarnationId:'review-v1',threadId:'review-thread'}};
 const binding={runtime:reviewOwner.runtime,sessionId:reviewOwner.sessionId,incarnationId:reviewOwner.incarnationId,cwd:f.cwd,...reviewOwner.worker};
 await f.ledger.withLock('review',async ledger=>{await ledger.append(intent);await ledger.append({event:'submission',unit:'review',seq:1,key,effect:'session.start',binding});});
 const rows=await f.ledger.withLock('review',ledger=>ledger.read()),record=await f.store.read('review');
 f.request.suspendedReviews=[{unit:'review',unitDigest:digest(record),ledgerDigest:digest(rows),owner:reviewOwner}];
 const oldObserve=f.adapters.session.observe;let reviewSuspended=true;
 f.adapters.session.observe=async input=>!input.suspendedOwner?f.replacement:input.suspendedOwner.sessionId==='old-review'?{...f.replacement,worker:{...f.replacement.worker,tty:'metadata',workspaceId:'ignored'},previousOwnerSuspended:reviewSuspended}:oldObserve(input);
 const oldApproval=f.adapters.provider.verifyUserInput;
 f.adapters.provider.verifyUserInput=async input=>input.effect==='unit.session.recover'?{...input,verified:input.userInputRef==='human'}:oldApproval(input);
 f.adapters.provider.verifySuspendedReviewRecovery=async input=>{
  const {request,intent,submission,original,goal,nextArgs,handover,suspension,...scalar}=input;
  return {...scalar,verified:true,receiverSuspended:true,receiver:submission.binding,evidenceDigest:request.provenance.digest};
 };
 const recover=async()=>{
  const goal=await f.goals.read('goal');
  const request={id:'recover-review',expectedRevision:record.revision,expectedGoalRevision:goal.revision,intent:{seq:1,key,argsDigest:digest(args)},provenance:{path:f.proof,digest:hash(await readFile(f.proof))},reason:'Resume suspended actual reviewer under authorized handoff'};
  const file=path.join(f.cwd,'recovery.json');await writeFile(file,JSON.stringify(request));
  return JSON.parse((await runUnitCli(['unit','session-recover','review','--request',file,'--user-input','human'],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters})).split('RESULT ').at(-1));
 };
 const start=async()=>{
  f.adapters.session.execute=async input=>{
   const prompt=(await loadManagedLaunch(input.args)).goalPrompt,identity={sessionId:'new-review',incarnationId:'new-review-v1',cwd:f.cwd};
   return {...identity,task:{...identity,schema:'harness.goal-receipt/1',effectKey:input.key,promptDigest:taskDigest(prompt),goalDigest:input.args.goalDigest,goal:{threadId:'new-review-thread',status:'active',objective:prompt},threadId:'new-review-thread',turnId:'turn',activityId:'read',packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};
  };
  const request={cwd:f.cwd,handoffPath,handoffDigest:taskDigest(packet),parentRuntime:f.replacement,waitSeconds:0},file=path.join(f.cwd,'review-start.json');await writeFile(file,JSON.stringify(request));
  return JSON.parse((await runUnitCli(['unit','session-start','review','--request',file],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters})).split('RESULT ').at(-1));
 };
 return {...f,recover,start,reviewOwner,intent,rows,record,unsuspendReview:()=>{reviewSuspended=false;}};
}
test('AC-4 suspended actual reviewer retains records and reserves the same review at a fresh attempt without claiming non-start',async t=>{
 const f=await suspendedReviewerFixture(t),reviewBytes=await readFile(path.join(f.stateRoot,'units/review/unit.json'));
 assert.equal((await f.run()).code,0);assert.notEqual((await f.start()).code,0);assert.deepEqual(await f.ledger.withLock('review',l=>l.read()),f.rows);
 assert.deepEqual(await readFile(path.join(f.stateRoot,'units/review/unit.json')),reviewBytes);
 const result=await f.recover();assert.equal(result.code,0,JSON.stringify(result));
 const rows=await f.ledger.withLock('review',l=>l.read()),retired=rows.findLast(r=>r.event==='session-start-recovery');
 assert.equal(retired.mode,'suspended-handoff');assert.equal(retired.nextArgs.attempt,2);assert.equal(retired.proof.receiverSuspended,true);assert.equal(retired.proof.taskNeverStarted,undefined);
 assert.deepEqual(rows.slice(0,f.rows.length),f.rows);assert.deepEqual(await readFile(path.join(f.stateRoot,'units/review/unit.json')),reviewBytes);
 const started=await f.start();assert.equal(started.code,0,JSON.stringify(started));
 const registered=(await f.goals.read('goal')).reviews;assert.equal(registered.length,1);assert.equal(registered[0].attempt,2);assert.equal(registered[0].nativeThreadId,'new-review-thread');
});
test('AC-5 suspended reviewer authority cannot hide registered, changed, running or completed work',async t=>{
 for(const scenario of ['running','changed-ledger','registered','stages','wrong-thread','missing-verifier','resume-before-recovery','receiver-drift','confirmation-drift'])await t.test(scenario,async t=>{
  const f=await suspendedReviewerFixture(t);
  if(scenario==='running')f.unsuspendReview();
  if(['receiver-drift','confirmation-drift'].includes(scenario)){
   await f.ledger.withLock('review',l=>l.append({event:scenario==='receiver-drift'?'receiver':'confirmation',seq:1,key:f.intent.key,binding:{runtime:'cmux',sessionId:'foreign',incarnationId:'foreign',cwd:f.cwd}}));
   f.request.suspendedReviews[0].ledgerDigest=digest(await f.ledger.withLock('review',l=>l.read()));
  }
  if(scenario==='changed-ledger')await f.ledger.withLock('review',l=>l.append({event:'verification',seq:1,key:f.intent.key,status:'unknown'}));
  if(scenario==='registered')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,reviews:[{unit:'review',targetUnit:'change'}]}));
  if(scenario==='stages')await f.store.update('review',r=>({...r,stages:[{stage:'review'}]}));
  if(scenario==='wrong-thread')f.request.suspendedReviews[0].owner.worker.threadId='foreign';
  if(scenario==='missing-verifier')delete f.adapters.provider.verifySuspendedReviewRecovery;
  if(['missing-verifier','resume-before-recovery'].includes(scenario)){
   assert.equal((await f.run()).code,0);if(scenario==='resume-before-recovery')f.unsuspendReview();assert.notEqual((await f.recover()).code,0);
  }else assert.notEqual((await f.run()).code,0);
 });
});


function exitedOwner(f){
 const original=f.adapters.session.observe;let absent=true;
 f.adapters.session.observe=async input=>input.exitedOwner?{...f.replacement,previousOwnerExited:absent}:input.suspendedOwner?.sessionId===f.previous.owner.sessionId?{...f.replacement,previousOwnerSuspended:false}:original(input);
 const approval=f.adapters.provider.verifyUserInput;
 f.adapters.provider.verifyUserInput=async input=>input.effect==='unit.session.reassign'?{...input,verified:input.userInputRef==='human' && input.previousOwnerState==='exited'}:approval(input);
 f.adapters.provider.verifyExitedOwnerHandoff=f.adapters.provider.verifySessionHandoff;
 return {...f,reassign:(request=f.request)=>f.run(request,'exited.json','session-reassign'),restoreSource:()=>{absent=false;}};
}
test('AC-6 exited-owner reassignment is a distinct sourced public observation, preserves unit bytes and rejects cross-mode replay',async t=>{
 const f=exitedOwner(await fixture(t)),before=await readFile(path.join(f.stateRoot,'units/change/unit.json'));
 assert.notEqual((await f.run()).code,0);
 const result=await f.reassign();assert.equal(result.code,0,JSON.stringify(result));
 const goal=await f.goals.read('goal');assert.equal(goal.handovers[0].mode,'exited-owner');assert.deepEqual(goalOwner(goal,'change').owner,f.replacement);
 assert.deepEqual(await readFile(path.join(f.stateRoot,'units/change/unit.json')),before);
 assert.equal((await f.reassign()).code,0);assert.deepEqual(await f.goals.read('goal'),goal);assert.notEqual((await f.run()).code,0);
});
test('AC-7 exited source with a worked suspended reviewer recovers that same reviewer normally',async t=>{
 const f=exitedOwner(await suspendedReviewerFixture(t));const reassigned=await f.reassign();assert.equal(reassigned.code,0,JSON.stringify(reassigned));
 assert.equal((await f.recover()).code,0);const started=await f.start();assert.equal(started.code,0,JSON.stringify(started));assert.equal((await f.goals.read('goal')).reviews[0].attempt,2);
});
test('AC-8 absence, authority and native failures cannot be replaced by an exited-owner request assertion',async t=>{
 for(const scenario of ['live','raced-live','denied','missing-verifier','stale-source','unknown-effect'])await t.test(scenario,async t=>{
  const f=exitedOwner(await fixture(t)),before=await f.goals.read('goal');
  if(scenario==='live')f.restoreSource();
  if(scenario==='raced-live')f.hook(()=>f.restoreSource());
  if(scenario==='denied')f.deny();
  if(scenario==='missing-verifier')delete f.adapters.provider.verifyExitedOwnerHandoff;
  if(scenario==='stale-source')await writeFile(f.source.path,'changed');
  if(scenario==='unknown-effect')await f.ledger.withLock('change',l=>l.append({event:'intent',effect:'git.push',seq:1,key:'unknown'}));
  assert.notEqual((await f.reassign()).code,0);assert.deepEqual(await f.goals.read('goal'),before);
 });
});
