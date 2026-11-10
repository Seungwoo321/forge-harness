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

const packet = ['목표: goal','수용 기준: done','작업관리: change','결정: approved','변경: retained','검증: source','남은 일·위험: access','다음 단위 첫 행동: resume'].join('\n');
const fields = {title:'Stopped change',objective:'goal',acceptance:'pending',tracking:'change',decision:'blocked',changed:'retained',verification:'source',remainingRisk:'access',nextFirstAction:'resume'};
const parse = output => JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
async function fixture(t, managed = false, stoppedFrom = 'Implementing') {
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
    failures:[{path:failurePath,digest:taskDigest('failure'),signature:'original'}],evidence:[{gate:'old',exit:1}],acceptance:[{id:'AC-1',text:'done'}],stages:[],openDecisions:[]});
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
      async observe(input){if(input.closedOwner)return {closed,owner};return input.cwd===cwd && input.targetCwd ? parent : owner;},
      async execute(input){assert.equal(input.effect,'session.start');launches++;const result={...fresh,task:{...fresh,schema:'harness.goal-receipt/1',effectKey:input.key,
        promptDigest:taskDigest('resume'),goalDigest:input.args.goalDigest,goal:{threadId:'fresh-thread',status:'active',objective:'resume'},threadId:'fresh-thread',turnId:'turn',activityId:'read',
        packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};receipts.set(input.key,result);return result;},
      async verify(input){return receipts.has(input.key)?{status:'completed',result:receipts.get(input.key)}:{status:'unknown'};}
    }};
  const run=async args=>parse(await runUnitCli(args,{cwd,stateRoot,adapters}));
  // Generate the original immutable stop packets through the public stop command.
  const stop=path.join(cwd,'stop.json');await writeFile(stop,JSON.stringify({parentRuntime:owner,handoffContent:packet,resultFields:fields,classification:'authority'}));
  const observed=adapters.session.observe;adapters.session.observe=async()=>owner;
  assert.equal((await run(['unit','session-stop','change','--request',stop])).code,0);adapters.session.observe=observed;
  const unitFile=path.join(stateRoot,'units/change/unit.json');
  const request=async(extra={})=>({id:'recover-1',expectedRevision:(await store.read('change')).revision,expectedGoalRevision:(await goals.read('goal')).revision,
    unitDigest:digest(await store.read('change')),goalDigest:digest(await goals.read('goal')),ledgerDigest:digest(await createLedgerStore(stateRoot).withLock('change',l=>l.read())),
    targetDigest:digest(target),custodyDigest:digest(custody),owner,provenance:{ref:authority,digest:taskDigest(authorityText)},reason:'Authorized external closure and same-unit recovery',...extra});
  let serial=0;
  const command=async(args,body)=>{const file=path.join(cwd,`request-${++serial}.json`);await writeFile(file,JSON.stringify(body));return run([...args,'--request',file]);};
  const recover=body=>command(['unit','stopped-owner-recover','change','--user-input','human'],body);
  const activate=async()=>command(['goal','resume','goal'],{expectedRevision:(await goals.read('goal')).revision,unit:'change',resolutionEvidence:'access granted'});
  const resume=async()=>{const file=path.join(cwd,'snapshot.json');await writeFile(file,JSON.stringify({git:{head:'head',checkpoints:{},worktreeDiff:[],indexDiff:[]}}));return run(['unit','resume','change','--snapshot',file]);};
  return {cwd,stateRoot,store,goals,unitFile,source,owner,custody,target,adapters,request,recover,run,activate,resume,
    setClosed:value=>{closed=value;},deny:()=>{authorized=false;},onVerify:value=>{hook=value;},launches:()=>launches,parent,command};
}

test('external closure observation preserves stopped history and public same-unit resume selects exactly one fresh owner',async t=>{
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
