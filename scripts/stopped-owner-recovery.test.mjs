import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAdapters} from './lib/adapters.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {effectArgsDigest as digest} from './lib/approvals.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {goalOwner} from './lib/continuity-custody.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';
import {createSessionRunner} from './lib/session-runtime.mjs';
import {gateFingerprint, canReuseEvidence} from './lib/evidence.mjs';
import {snapshotGoal} from './lib/continuity-snapshot.mjs';
import {prepareEffect} from './lib/policy.mjs';
import {recoverGoalSession} from './lib/continuity-recover.mjs';
import {recoverStoppedOwner} from './lib/stopped-owner-recovery.mjs';

const packet = ['목표: goal','수용 기준: done','작업관리: change','결정: approved','변경: retained','검증: source','남은 일·위험: access','다음 단위 첫 행동: resume'].join('\n');
const fields = {title:'Stopped change',objective:'goal',acceptance:'pending',tracking:'change',decision:'blocked',changed:'retained',verification:'source',remainingRisk:'access',nextFirstAction:'resume'};
const parse = output => JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
async function fixture(t, managed = false, stoppedFrom = 'Implementing', normal = false) {
  const cwd = await mkdtemp(path.join(tmpdir(),'stopped-owner-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateRoot = path.join(cwd,'state'), store = createUnitStateStore(stateRoot), goals = createContinuityStore(stateRoot);
  const source = path.join(cwd,'goal.md');await writeFile(source,'goal');
  const policy = {runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']};
  const owner = {runtime:'cmux',sessionId:'retained',incarnationId:'old-v1',cwd,worker:{executable:'/bin/codex',pid:42,incarnationId:'old-worker',threadId:'old-thread'}};
  const custody = managed ? {unit:'change',attempt:1,sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd}
    : {unit:'change',ownership:'existing',...owner,owner,policyDigest:digest(policy)};
  await goals.create({goal:{id:'goal',objective:'goal',criteria:['done'],remaining:['change'],status:'active'},policy,source:{path:source,digest:taskDigest('goal')}});
  await goals.transaction('goal',g=>({...g,revision:g.revision+1,[managed?'bootstraps':'adoptions']:[custody]}));
  await mkdir(path.join(stateRoot,'units/change/failures'),{recursive:true});
  const failurePath='units/change/failures/f1.json';await writeFile(path.join(stateRoot,failurePath),'failure');
  await store.create({schema:'harness.unit/1',unit:'change',kind:'impl',state:'Stopped',stoppedFrom,continuity:{goalId:'goal'},policy:{goal:{class:'product-prelaunch'},session:policy},canon:[],
    ...(normal ? {accepted:{head:'head',contentFingerprint:'content'},reviewDecision:{required:true,head:'head',contentFingerprint:'content'}} : {}),
    failures:[{path:failurePath,digest:taskDigest('failure'),signature:'original'}],evidence:[{gate:'lint',fingerprint:'old',exit:0,status:'passed'}],acceptance:[{id:'AC-1',text:'done'}],stages:[],openDecisions:[]});
  await goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,status:'blocked',blocker:{unit:'change',reason:'access',resumeCondition:'access granted',evidence:failurePath}}}));
  let closed=true, authorized=true, hook=async()=>{}, launches=0;
  const target={head:'head',contentFingerprint:'content'}, parent={runtime:'cmux',sessionId:'supervisor',incarnationId:'parent-v1',cwd};
  const fresh={sessionId:'fresh',incarnationId:'fresh-v1',cwd};const receipts=new Map();
  const authority=path.join(cwd,'authority.txt'), authorityText='Explicitly close the retained owner and recover the same stopped change under this execution policy.';await writeFile(authority,authorityText);
  const adapters={...createAdapters(),git:{inspectUnit:async()=>({...target})},provider:{
    verifyUserInput:async input=>({...input,verified:authorized && input.userInputRef==='human' && input.effect==='unit.stopped-owner.recover'}),
    async verifyStoppedOwnerRecovery(input) {
      const verified=input.request.provenance.ref===authority && input.request.provenance.digest===taskDigest(await readFile(authority))
        && await readFile(authority,'utf8')===authorityText && input.ownerDigest===digest(owner) && input.policyDigest===digest(policy)
        && input.unitDigest===digest(input.record) && input.goalDigest===digest(input.goal) && input.custodyDigest===digest(custody);
      await hook();return {...input,verified};
    }},session:{
      async observe(input){if(normal && input.recipient)return {...parent,executable:'/bin/codex'};if(input.closedOwner)return {closed,owner:input.closedOwner};return input.cwd===cwd && input.targetCwd ? parent : owner;},
      async execute(input){
        if(normal && input.effect==='session.close'){const result={sessionId:owner.sessionId,incarnationId:owner.incarnationId,closed:true};receipts.set(input.key,result);return result;}
        if(normal && input.effect==='session.deliver'){const result={...parent,task:{...parent,schema:'harness.task-receipt/1',effectKey:input.key,promptDigest:taskDigest('return'),threadId:'parent-thread',requestId:'return',turnId:'return-turn',activityId:'read',packets:['result','handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};receipts.set(input.key,result);return result;}
        assert.equal(input.effect,'session.start');launches++;const result={...fresh,task:{...fresh,schema:'harness.goal-receipt/1',effectKey:input.key,
        promptDigest:taskDigest('resume'),goalDigest:input.args.goalDigest,goal:{threadId:'fresh-thread',status:'active',objective:'resume'},threadId:'fresh-thread',turnId:'turn',activityId:'read',
        packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};receipts.set(input.key,result);return result;},
      async verify(input){if(normal && input.effect==='session.close' && !closed)return {status:'unknown'};return receipts.has(input.key)?{status:'completed',result:receipts.get(input.key)}:{status:'unknown'};}
    }};
  const run=async args=>parse(await runUnitCli(args,{cwd,stateRoot,adapters}));
  // Generate the original immutable stop packets through the public stop command.
  const stop=path.join(cwd,'stop.json');await writeFile(stop,JSON.stringify({parentRuntime:owner,handoffContent:packet,resultFields:fields,classification:'authority',...(normal ? {returnTo:{...parent,executable:'/bin/codex'}} : {})}));
  const observed=adapters.session.observe;adapters.session.observe=async input=>normal && input.recipient ? {...parent,executable:'/bin/codex'} : {...owner,closable:true};
  assert.equal((await run(['unit','session-stop','change','--request',stop])).code,normal ? 3 : 0);
  if(normal)assert.equal((await run(['unit','finalize','change'])).code,0);
  adapters.session.observe=observed;
  const unitFile=path.join(stateRoot,'units/change/unit.json');
  const request=async(extra={})=>({id:'recover-1',expectedRevision:(await store.read('change')).revision,expectedGoalRevision:(await goals.read('goal')).revision,
    unitDigest:digest(await store.read('change')),goalDigest:digest(await goals.read('goal')),ledgerDigest:digest(await createLedgerStore(stateRoot).withLock('change',l=>l.read())),
    targetDigest:digest(target),custodyDigest:digest(custody),owner,provenance:{ref:authority,digest:taskDigest(authorityText)},reason:'Authorized external closure and same-unit recovery',...extra});
  let serial=0;
  const command=async(args,body)=>{const file=path.join(cwd,`request-${++serial}.json`);await writeFile(file,JSON.stringify(body));return run([...args,'--request',file]);};
  const recover=body=>command(['unit','stopped-owner-recover','change','--user-input','human'],body);
  const activate=async()=>command(['goal','resume','goal'],{expectedRevision:(await goals.read('goal')).revision,unit:'change',resolutionEvidence:'access granted'});
  const resume=async(extra={})=>{const file=path.join(cwd,'snapshot.json');await writeFile(file,JSON.stringify({git:{head:'head',checkpoints:{},worktreeDiff:[],indexDiff:[]},currentFingerprints:{lint:'old'},...extra}));return run(['unit','resume','change','--snapshot',file]);};
  return {cwd,stateRoot,store,goals,unitFile,source,owner,custody,target,adapters,request,recover,run,activate,resume,
    setClosed:value=>{closed=value;},deny:()=>{authorized=false;},onVerify:value=>{hook=value;},launches:()=>launches,parent,command};
}

test('external closure observation preserves stopped history and public same-unit resume selects exactly one fresh owner (AC-3)',async t=>{
 for(const managed of [false,true])for(const stoppedFrom of ['Implementing','SelfGated','InReview','Accepted'])await t.test(`${managed?'managed':'existing'} retained ${stoppedFrom}`,async t=>{
  const f=await fixture(t,managed,stoppedFrom),before=await readFile(f.unitFile),oldGoal=await f.goals.read('goal'),request=await f.request();
  assert.equal((await f.activate()).error,'SESSION_CLOSE_PENDING');
  const results=await Promise.all([f.recover(request),f.recover(request)]);for(const result of results)assert.equal(result.code,0,JSON.stringify(result));
  assert.equal(results.filter(x=>x.receipt.duplicate).length,1);
  assert.deepEqual(await readFile(f.unitFile),before);let goal=await f.goals.read('goal');
  assert.deepEqual(goal.adoptions,oldGoal.adoptions);assert.deepEqual(goal.bootstraps,oldGoal.bootstraps);assert.equal(goal.stoppedOwnerRecoveries.length,1);assert.equal(goalOwner(goal,'change'),undefined);
  assert.equal((await f.activate()).code,0);assert.equal((await f.resume()).code,0);
  const resumed=await f.store.read('change'),original=JSON.parse(before);
  for(const key of ['stopReport','failures','evidence','acceptance','stages'])assert.deepEqual(resumed[key],original[key]);
  assert.equal(resumed.state,stoppedFrom);assert.equal(resumed.sessionHistory[0].mode,'stopped-observation');assert.equal(resumed.sessionFinalization,undefined);
  const handoff=path.join(f.cwd,'resume.md');await writeFile(handoff,packet);
  const start={cwd:f.cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:f.parent,waitSeconds:0};
  const starts=await Promise.all([f.command(['unit','session-start','change'],start),f.command(['unit','session-start','change'],start)]);
  for(const result of starts)assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.launches(),1);
  goal=await f.goals.read('goal');assert.equal(goalOwner(goal,'change').sessionId,'fresh');assert.equal(goalOwner(goal,'change').attempt,2);
  assert.notEqual((await f.recover(request)).code,0);assert.equal(goal.stoppedOwnerRecoveries.length,1);
 });
});

async function pendingReview(f) {
  const goal=await f.goals.read('goal');
  await f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'},failures:[{id:'original-start-failure'}]});
  const {blocker,...definition}=goal.goal;
  const snapshot=await snapshotGoal(f.stateRoot,{...goal,goal:{...definition,status:'active'}});
  const report=(await f.store.read('change')).stopReport;
  const args={unit:'review',role:'review',attempt:1,cwd:f.cwd,handoffPath:report.handoffPath,handoffDigest:report.handoffDigest,goalPath:snapshot.path,goalDigest:snapshot.digest};
  const key=prepareEffect('session.start',args).key,ledger=createLedgerStore(f.stateRoot);
  await ledger.withLock('review',l=>l.append({event:'intent',effect:'session.start',unit:'review',seq:1,key,args}));
  const before=await f.store.read('review');
  const proofPath=path.join(f.cwd,'review-non-start.json');await writeFile(proofPath,'native terminal non-start');
  const verify=f.adapters.provider.verifyUserInput;
  f.adapters.provider.verifyUserInput=async b=>b.effect==='unit.session.recover'?{...b,verified:b.userInputRef==='human'}:verify(b);
  f.adapters.provider.verifySessionStartRecovery=async ({request,intent,submission,original,goal,nextArgs,target,settleOnly,...binding})=>{
    assert.equal(settleOnly,true);assert.equal(nextArgs,null);assert.equal(original.policy.account,'/account');assert.equal(binding.targetDigest,digest(target));
    assert.equal(await readFile(request.provenance.path,'utf8'),'native terminal non-start');
    return {...binding,verified:true,taskNeverStarted:true,receiverStopped:true,queueCancelled:true,evidenceDigest:taskDigest(await readFile(proofPath)),
      receiver:{runtime:'cmux',sessionId:'never-started-review',incarnationId:'review-v1',cwd:f.cwd,threadId:'review-thread',pid:43,executable:'/bin/codex'}};
  };
  const recovery={id:'settle-review',expectedRevision:before.revision,expectedGoalRevision:goal.revision,intent:{key,seq:1,argsDigest:digest(args)},
    provenance:{path:proofPath,digest:taskDigest(await readFile(proofPath))},reason:'Authorized original review terminal non-start settlement'};
  return {before,recovery,ledger};
}

test('public terminal review settlement unlocks stopped owner recovery and normal goal/unit resume without a review close receipt',async t=>{
  const f=await fixture(t,false,'InReview'),{before,recovery,ledger}=await pendingReview(f),request=await f.request();
  assert.equal((await f.recover(request)).error,'CUSTODY_CONFLICT');
  const settled=await f.command(['unit','session-recover','review','--user-input','human'],recovery);
  assert.equal(settled.code,0,JSON.stringify(settled));assert.equal(settled.receipt.settled,true);
  assert.equal((await f.recover(request)).code,0);assert.equal((await f.activate()).code,0);assert.equal((await f.resume()).code,0);
  assert.deepEqual(await f.store.read('review'),before);assert.equal((await f.store.read('change')).state,'InReview');
  const rows=await ledger.withLock('review',l=>l.read());assert.deepEqual(rows.map(r=>r.event),['intent','session-start-recovery']);assert.equal(f.launches(),0);
});

test('concurrent reviewer settlement and stopped-owner recovery fail closed without a cross-operation lock cycle',async t=>{
  const f=await fixture(t,false,'InReview'),{recovery,ledger}=await pendingReview(f),request=await f.request();
  let enterOwner,releaseOwner,reviewWaiting;
  const entered=new Promise(r=>{enterOwner=r;}),ownerGate=new Promise(r=>{releaseOwner=r;}),waiting=new Promise(r=>{reviewWaiting=r;});
  const inspect=f.adapters.git.inspectUnit;
  f.adapters.git.inspectUnit=async input=>{enterOwner();await ownerGate;return inspect(input);};
  const owner=recoverStoppedOwner({stateRoot:f.stateRoot,store:f.store,unit:'change',request,userInputRef:'human',adapters:f.adapters});
  await entered;
  const store={...f.store,withLock:async(unit,action)=>{if(unit==='change')reviewWaiting();return f.store.withLock(unit,action);}};
  const reviewer=recoverGoalSession({stateRoot:f.stateRoot,store,unit:'review',request:recovery,userInputRef:'human',adapters:f.adapters});
  await waiting;releaseOwner();
  let timer;
  try {
    const results=await Promise.race([Promise.allSettled([owner,reviewer]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cross-operation lock cycle')),5000);})]);
    assert.equal(results[0].status,'rejected');assert.equal(results[0].reason.code,'EFFECT_UNCERTAIN');
    assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.settled,true);
  } finally {clearTimeout(timer);releaseOwner();}
  assert.equal((await f.recover(request)).code,0);assert.equal(f.launches(),0);
  assert.deepEqual((await ledger.withLock('review',l=>l.read())).map(r=>r.event),['intent','session-start-recovery']);
});

test('stale, unauthorized, ambiguous and conflicting attempts preserve canonical records and perform no effects',async t=>{
 const modes=['unit-revision','goal-revision','unit-digest','goal-digest','ledger-digest','target-digest','custody-digest','source','packet','failure','permission','provenance','policy','owner','closure','missing-verifier','unknown-effect','review','target-race','closure-race','source-race','invalid-origin'];
 for(const mode of modes)await t.test(mode,async t=>{
  const f=await fixture(t),request=await f.request();
  if(mode==='unit-revision')request.expectedRevision++;
  if(mode==='invalid-origin'){await f.store.update('change',r=>({...r,stoppedFrom:'Delivered'}));request.expectedRevision=(await f.store.read('change')).revision;request.unitDigest=digest(await f.store.read('change'));}
  if(mode==='goal-revision')request.expectedGoalRevision++;
  for(const key of ['unit','goal','ledger','target','custody'])if(mode===`${key}-digest`)request[`${key}Digest`]=taskDigest('changed');
  if(mode==='source')await writeFile(f.source,'changed');
  if(mode==='packet')await writeFile((await f.store.read('change')).stopReport.handoffPath,'changed');
  if(mode==='failure')await writeFile(path.join(f.stateRoot,'units/change/failures/f1.json'),'changed');
  if(mode==='permission')f.deny();
  if(mode==='provenance')request.provenance.digest=taskDigest('forged');
  if(mode==='policy')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,policy:{...g.policy,account:'/other'}}));
  if(mode==='owner')request.owner={...request.owner,sessionId:'foreign'};
  if(mode==='closure')f.setClosed(undefined);
  if(mode==='missing-verifier')delete f.adapters.provider.verifyStoppedOwnerRecovery;
  if(mode==='unknown-effect'){await createLedgerStore(f.stateRoot).withLock('change',l=>l.append({event:'intent',unit:'change',seq:1,key:'unknown',effect:'git.push'}));request.ledgerDigest=digest(await createLedgerStore(f.stateRoot).withLock('change',l=>l.read()));}
  if(mode==='review')await f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',targetUnit:'change',state:'InReview',continuity:{goalId:'goal'}});
  if(mode==='target-race')f.onVerify(async()=>{f.target.head='changed';});
  if(mode==='closure-race')f.onVerify(async()=>{f.setClosed(false);});
  if(mode==='source-race')f.onVerify(async()=>{await writeFile(f.source,'changed');});
  const before=await readFile(f.unitFile),goal=await f.goals.read('goal'),result=await f.recover(request);
  assert.notEqual(result.code,0,JSON.stringify(result));if(mode==='unknown-effect')assert.equal(result.error,'EFFECT_UNCERTAIN');assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);assert.equal(f.launches(),0);
 });
});

test('a recovered observation cannot authorize a changed request, target, native owner or later goal state',async t=>{
 for(const phase of ['retry','goal-resume','unit-resume'])await t.test(phase,async t=>{
  const f=await fixture(t),request=await f.request();assert.equal((await f.recover(request)).code,0);
  assert.equal((await f.recover({...request,reason:'different'})).error,'STOPPED_OWNER_CONFLICT');
  if(phase==='unit-resume')assert.equal((await f.activate()).code,0);
  f.setClosed(false);const before=await readFile(f.unitFile),goal=await f.goals.read('goal');
  const result=phase==='retry'?await f.recover(request):phase==='goal-resume'?await f.activate():await f.resume();
  assert.notEqual(result.code,0,JSON.stringify(result));assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);
 });
});

test('different concurrent recovery IDs cannot both retire custody',async t=>{
 const f=await fixture(t),request=await f.request();const results=await Promise.all([f.recover(request),f.recover({...request,id:'other'})]);
 assert.equal(results.filter(result=>result.code===0).length,1);assert.equal((await f.goals.read('goal')).stoppedOwnerRecoveries.length,1);assert.equal(f.launches(),0);
});

test('native external closure observer requires complete inventory and process absence, without executing closure',async t=>{
 for(const runtime of ['cmux','orca'])for(const mode of ['absent','surface-live','process-live','inventory-unknown','process-unknown','surface-race','process-race','transport-failure'])await t.test(`${runtime}: ${mode}`,async()=>{
  const owner={runtime,sessionId:'old',incarnationId:'old-v1',cwd:'/project',worker:{pid:42,incarnationId:'worker-v1',threadId:'thread',executable:'/bin/codex'}};
  let trees=0,processes=0;const calls=[];
  const command=async(binary,args)=>{calls.push([binary,args]);let output;
   if(binary==='ps'){processes++;output=mode==='process-unknown'?'?':mode==='process-live'||mode==='process-race'&&processes===2?'1\n42':'1\n2';}
   else {trees++;if(mode==='transport-failure')return {exitCode:1,stdout:''};const live=mode==='surface-live'||mode==='surface-race'&&trees===2;
    output=JSON.stringify(mode==='inventory-unknown'?{}:runtime==='cmux'?{windows:[{workspaces:[{panes:[{surfaces:live?[{id:'old'}]:[]}]}]}]}:{terminals:live?[{handle:'old'}]:[]});}
   return {exitCode:0,stdout:output};
  };
  const runner=createSessionRunner({runtime,command,parent:{sessionId:'supervisor',incarnationId:'v1',cwd:'/project'},launch:()=>{throw Error('unexpected launch');}});
  if(mode==='absent')assert.deepEqual(await runner.observe({closedOwner:owner}),{closed:true,owner});
  else await assert.rejects(runner.observe({closedOwner:owner}),{code:'SESSION_OBSERVATION_INVALID'});
  assert.ok(calls.every(([binary,args])=>binary==='ps'||!args.some(arg=>arg.startsWith('close'))));
 });
});

test('goal and unit resume revalidate complete target, ledger, policy and authority bindings',async t=>{
 for(const phase of ['goal','unit'])for(const mode of ['target','ledger','policy','unit','permission','source'])await t.test(`${phase}: ${mode}`,async t=>{
  const f=await fixture(t),request=await f.request();assert.equal((await f.recover(request)).code,0);
  if(phase==='unit')assert.equal((await f.activate()).code,0);
  if(mode==='target')f.target.contentFingerprint='changed';
  if(mode==='ledger')await createLedgerStore(f.stateRoot).withLock('change',l=>l.append({event:'observation',detail:'changed'}));
  if(mode==='policy')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,policy:{...g.policy,model:'other'}}));
  if(mode==='unit')await f.store.update('change',r=>({...r,extra:'changed'}));
  if(mode==='permission')f.deny();
  if(mode==='source')await writeFile(f.source,'changed');
  const before=await readFile(f.unitFile),goal=await f.goals.read('goal');const result=phase==='goal'?await f.activate():await f.resume();
  assert.notEqual(result.code,0,JSON.stringify(result));assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);assert.equal(f.launches(),0);
 });
});

test('packaged adapter resolves recovery requests and goal/unit resume to the exact historical closed owner',async t=>{
 const {createRuntimeAdapters}=await import('./session-adapter.mjs');
 const f=await fixture(t),request=await f.request(),file=path.join(f.cwd,'packaged-request.json');
 const command=async(binary,args)=>({exitCode:0,stdout:binary==='ps'?'1\n2':JSON.stringify({windows:[]})});
 const options={'state-root':f.stateRoot,request:file};
 await writeFile(file,JSON.stringify(request));
 let registered=await createRuntimeAdapters({cwd:f.cwd,adapters:{command},options,argv:['unit','stopped-owner-recover','change']});
 assert.deepEqual(await registered.sessionRunner.observe({closedOwner:f.owner}),{closed:true,owner:f.owner});
 assert.equal((await f.recover(request)).code,0);
 await writeFile(file,JSON.stringify({unit:'change'}));
 registered=await createRuntimeAdapters({cwd:f.cwd,adapters:{command},options,argv:['goal','resume','goal']});
 assert.deepEqual(await registered.sessionRunner.observe({closedOwner:f.owner}),{closed:true,owner:f.owner});
 registered=await createRuntimeAdapters({cwd:f.cwd,adapters:{command},options:{'state-root':f.stateRoot},argv:['unit','resume','change']});
 assert.deepEqual(await registered.sessionRunner.observe({closedOwner:f.owner}),{closed:true,owner:f.owner});
});

test('AC-1 AC-2 recovered stale evidence resumes to executable gates and requires fresh independent review',async t=>{
 for(const origin of ['SelfGated','InReview','Accepted'])await t.test(origin,async t=>{
  const f=await fixture(t,false,origin);
  await f.store.update('change',r=>({...r,policy:{...r.policy,review:{mode:'required',by:'session',triggers:[]}},
   accepted:origin==='Accepted'?{head:'head',contentFingerprint:'content'}:null,
   reviewedHead:'head',verdict:'ship',reviewDecision:{required:true,by:'session',contentFingerprint:'content'}}));
  const original=await f.store.read('change');
  assert.equal((await f.recover(await f.request())).code,0);assert.equal((await f.activate()).code,0);
  // Snapshot evidence cannot hide the persisted lint result.
  const result=await f.resume({evidence:[],currentFingerprints:{lint:'new'}});
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.stage,'gates');assert.equal(result.recovery.action,'rerun-gate');
  const resumed=await f.store.read('change');assert.equal(resumed.state,'SelfGated');assert.equal(resumed.accepted,null);
  assert.equal(resumed.reviewedHead,null);assert.equal(resumed.verdict,null);assert.equal(resumed.reviewDecision,null);
  for(const key of ['failures','stages','acceptance'])assert.deepEqual(resumed[key],original[key]);
  assert.deepEqual(resumed.evidence.slice(0,original.evidence.length),original.evidence);
  assert.equal(resumed.evidence.at(-1).status,'stale');assert.deepEqual(resumed.evidence.at(-1).covers,[]);
  assert.equal(canReuseEvidence(resumed.evidence.at(-1),'old',{id:'lint'}),false);
  assert.equal(resumed.sessionHistory.at(-1).mode,'stopped-observation');assert.ok(resumed.stopReport);
  assert.deepEqual(resumed.resumeRevalidations[0].previousAcceptance,original.accepted);
  assert.equal(resumed.resumeRevalidations[0].previousReview.verdict,'ship');
  const handoff=path.join(f.cwd,'revalidate.md');await writeFile(handoff,packet);
  assert.equal((await f.command(['unit','session-start','change'],{cwd:f.cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:f.parent,waitSeconds:0})).code,0);
  assert.equal(f.launches(),1);
  const source='gate source';await writeFile(path.join(f.cwd,'gate.mjs'),source);
  const executions=[];
  f.adapters.gates={async describe(id){return {id,command:['node','gate.mjs',id],files:[{path:'gate.mjs',content:source}],format:'tap',acPattern:'AC-1'};}};
  f.adapters.command=async(_binary,args)=>{executions.push(args.at(-1));return {exitCode:0,stdout:'TAP version 13\n1..1\nok 1 - AC-1 current validation\n'};};
  const acceptance=await f.run(['unit','accept','change']);assert.equal(acceptance.code,20,JSON.stringify(acceptance));
  assert.deepEqual(executions,['typecheck','lint','tests','build','acceptance-coverage']);
  const reviewed=await f.store.read('change');assert.equal(reviewed.state,'InReview');assert.equal(reviewed.accepted,null);
  assert.equal(reviewed.reviewedHead,null);assert.equal(reviewed.reviewDecision.required,true);
  assert.equal(reviewed.evidence.filter(e=>e.gate==='lint').at(-1).fingerprint,gateFingerprint(await f.adapters.gates.describe('lint')));
  assert.equal((await f.run(['unit','accept','change'])).code,20);assert.equal(executions.length,5);
 });
});

test('AC-2 stale-evidence resume preserves stopped state when authority, closure or inspection conflicts',async t=>{
 for(const mode of ['permission','closure','source','target','unit','review','pending-effect','checkpoint','fingerprint','tracker'])await t.test(mode,async t=>{
  const f=await fixture(t,false,'SelfGated');
  if(mode==='checkpoint')await f.store.update('change',r=>({...r,stages:[{name:'implement',attempts:[{n:1,checkpoint:'checkpoint'}]}]}));
  if(mode==='tracker')await f.store.update('change',r=>({...r,tracker:{ref:'tracker'}}));
  assert.equal((await f.recover(await f.request())).code,0);assert.equal((await f.activate()).code,0);
  if(mode==='permission')f.deny();if(mode==='closure')f.setClosed(false);if(mode==='source')await writeFile(f.source,'changed');
  if(mode==='target')f.target.head='other';if(mode==='unit')await f.store.update('change',r=>({...r,extra:'changed'}));
  if(mode==='review')await f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'}});
  if(mode==='pending-effect')await createLedgerStore(f.stateRoot).withLock('change',l=>l.append({event:'intent',unit:'change',seq:1,key:'pending',effect:'git.push'}));
  const before=await readFile(f.unitFile),goal=await f.goals.read('goal');
  const result=await f.resume({currentFingerprints:mode==='fingerprint'?{}:{lint:'new'}});
  assert.notEqual(result.code,0,JSON.stringify(result));assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);assert.equal(f.launches(),0);
 });
});

test('AC-1 stale evidence at an unfinished scope or implementation resumes its original stage before mandatory gates',async t=>{
 for(const origin of ['Scoped','Implementing'])await t.test(origin,async t=>{
  const f=await fixture(t,false,origin);assert.equal((await f.recover(await f.request())).code,0);assert.equal((await f.activate()).code,0);
  const result=await f.resume({currentFingerprints:{lint:'new'}});assert.equal(result.code,0,JSON.stringify(result));
  assert.equal(result.state,origin);assert.equal(result.stage,origin==='Scoped'?'scope':'implement');
  assert.equal((await f.store.read('change')).evidence.at(-1).status,'stale');
  assert.equal((await f.run(['unit','accept','change'])).error,'INVALID_TRANSITION');
 });
});


test('normal verified stopped closure resumes post-gate states with fresh validation and one next owner (AC-1 AC-2)',async t=>{
 for(const state of ['SelfGated','InReview','Accepted'])await t.test(state,async t=>{
  const f=await fixture(t,true,state,true),before=await f.store.read('change');
  assert.equal(before.sessionFinalization.closeReceipt.result.closed,true);
  assert.equal((await f.activate()).code,0);
  const resumed=await f.resume({currentFingerprints:{lint:'fresh'}});
  assert.equal(resumed.code,0,JSON.stringify(resumed));assert.equal(resumed.recovery.action,'rerun-gate');
  const record=await f.store.read('change');
  assert.deepEqual(record.sessionHistory,[before.sessionFinalization]);assert.deepEqual(record.failures,before.failures);
  assert.equal(record.accepted,null);assert.equal(record.reviewDecision,null);assert.equal(record.evidence.at(-1).status,'stale');
  const handoff=path.join(f.cwd,'resume.md');await writeFile(handoff,packet);
  const start={cwd:f.cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:f.parent,waitSeconds:0};
  const results=await Promise.all([f.command(['unit','session-start','change'],start),f.command(['unit','session-start','change'],start)]);
  for(const result of results)assert.equal(result.code,0,JSON.stringify(result));
  assert.equal((await f.command(['unit','session-start','change'],start)).code,0);
  assert.equal(f.launches(),1);assert.equal(goalOwner(await f.goals.read('goal'),'change').attempt,2);
  assert.deepEqual((await f.store.read('change')).sessionHistory,[before.sessionFinalization]);
 });
});

test('normal stopped startup rejects live, foreign, stale, incomplete and unproven closure (AC-2)',async t=>{
 for(const variant of ['live','foreign','stale','incomplete','unproven','pending','foreign-custody','missing-result','pending-result','running-result','uncertain-latest','unknown-latest'])await t.test(variant,async t=>{
  const f=await fixture(t,true,'SelfGated',true);
  assert.equal((await f.activate()).code,0);assert.equal((await f.resume({currentFingerprints:{lint:'fresh'}})).code,0);
  if(variant==='live')f.setClosed(false);
  else if(variant==='unproven'){
   const observe=f.adapters.session.observe;f.adapters.session.observe=async input=>input.closedOwner?{closed:false}:observe(input);
  }else if(variant==='foreign-custody')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,bootstraps:[...g.bootstraps,{unit:'change',attempt:99,sessionId:'foreign',incarnationId:'foreign-v1',cwd:f.cwd}]}));
  else if(variant==='missing-result')await f.store.update('change',record=>({...record,sessionHistory:record.sessionHistory.map(plan=>({...plan,closeReceipt:{...plan.closeReceipt,seq:999}}))}));
  else if(['pending-result','running-result','uncertain-latest','unknown-latest'].includes(variant))await createLedgerStore(f.stateRoot).withLock('change',async l=>{
   await l.append({event:'intent',effect:'session.deliver',unit:'change',seq:99,key:'unresolved',args:{}});
   if(variant.endsWith('-latest'))await l.append({event:'result',unit:'change',seq:99,key:'unresolved',result:{status:'completed'}});
   await l.append({event:'result',unit:'change',seq:99,key:'unresolved',result:{status:variant.split('-')[0]}});
  });
  else if(variant==='pending')await createLedgerStore(f.stateRoot).withLock('change',l=>l.append({event:'intent',effect:'session.deliver',unit:'change',seq:99,key:'pending',args:{}}));
  else await f.store.update('change',record=>{
   const plan=structuredClone(record.sessionHistory.at(-1));
   if(variant==='foreign')plan.owner.sessionId='foreign';
   if(variant==='stale')plan.resultDigest=taskDigest('stale');
   if(variant==='incomplete')delete plan.closeReceipt;
   return {...record,sessionHistory:[plan]};
  });
  const handoff=path.join(f.cwd,'resume.md');await writeFile(handoff,packet);
  const result=await f.command(['unit','session-start','change'],{cwd:f.cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:f.parent,waitSeconds:0});
  assert.notEqual(result.code,0,JSON.stringify(result));assert.equal(result.error,'CONTINUITY_INVALID');assert.equal(f.launches(),0);
  const rows=await createLedgerStore(f.stateRoot).withLock('change',l=>l.read());assert.equal(rows.filter(row=>row.event==='intent' && row.effect==='session.start').length,0);
 });
});

test('normal stopped startup uses native closed-owner observation from a distinct supervisor (AC-1 AC-2)',async t=>{
 const f=await fixture(t,true,'SelfGated',true);
 assert.equal((await f.activate()).code,0);assert.equal((await f.resume({currentFingerprints:{lint:'fresh'}})).code,0);
 const calls=[];
 const native=createSessionRunner({runtime:'cmux',parent:{...f.parent,closable:true,workerExecutable:'/bin/codex'},launch:()=>{throw Error('unexpected launch');},
  command:async(binary,args)=>{calls.push([binary,args]);
   if(binary==='ps')return {exitCode:0,stdout:'1\n2'};
   assert.equal(binary,'cmux');assert.deepEqual(args,['--json','--id-format','uuids','tree','--all']);
   return {exitCode:0,stdout:JSON.stringify({windows:[{workspaces:[{panes:[{surfaces:[]}]}]}]})};
  }});
 const plan=(await f.store.read('change')).sessionHistory.at(-1),rows=await createLedgerStore(f.stateRoot).withLock('change',l=>l.read());
 const close=rows.find(row=>row.event==='intent' && row.effect==='session.close');
 // A new supervisor has no authority to replay the old owner's close effect.
 assert.equal((await native.verify({effect:'session.close',args:close.args,key:close.key,seq:close.seq})).status,'unknown');
 const observe=f.adapters.session.observe,verify=f.adapters.session.verify;
 f.adapters.session.observe=input=>input.closedOwner?native.observe(input):observe(input);
 f.adapters.session.verify=input=>input.effect==='session.close'?native.verify(input):verify(input);
 const handoff=path.join(f.cwd,'resume.md');await writeFile(handoff,packet);
 const start={cwd:f.cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:f.parent,waitSeconds:0};
 const result=await f.command(['unit','session-start','change'],start);
 assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.launches(),1);
 assert.deepEqual(plan.owner.worker,f.owner.worker);assert.ok(calls.length>0);
 assert.ok(calls.every(([binary,args])=>binary==='ps'||args.includes('tree')));
});
