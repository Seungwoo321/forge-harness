import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createLedgerStore,executeEffect,sessionStartRetired} from './lib/ledger.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {startGoalSession} from './lib/continuity-start.mjs';
import {recoverGoalSession} from './lib/continuity-recover.mjs';
import {loadManagedLaunch} from './lib/continuity-launch-io.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';
import {decideResume} from './lib/resume.mjs';
import {taskDigest} from './lib/session-task.mjs';

const hash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const result=output=>JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
async function fixture(t,{submitted=true}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'start-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'goal.md'),handoffPath=path.join(root,'handoff.md'),provenancePath=path.join(root,'native-proof.json');
  await writeFile(source,'goal');
  const packet=['목표: goal','수용 기준: done','작업관리: unit','결정: policy','변경: none','검증: none','남은 일·위험: work','다음 단위 첫 행동: begin'].join('\n');await writeFile(handoffPath,packet);
  const goals=createContinuityStore(root),store=createUnitStateStore(root),ledgerStore=createLedgerStore(root);
  const policy={runtime:'orca',provider:'claude',account:'/old-account',model:'model',effort:'high',argv:['claude']};
  await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy,source:{path:source,digest:hash('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Implementing',continuity:{goalId:'g'},policy:{goal:{class:'product-prelaunch'}},failures:[{id:'original-auth-failure'}]});
  const startRequest={cwd:root,handoffPath,handoffDigest:hash(packet),parentRuntime:{sessionId:'parent',incarnationId:'parent-1',cwd:root},waitSeconds:0};
  const receiver={runtime:'orca',sessionId:'old',incarnationId:'old-1',cwd:root,threadId:'original-thread',pid:42,executable:'claude'};
  const evidence={receiver,taskNeverStarted:true,receiverStopped:true,queueCancelled:true};
  await writeFile(provenancePath,JSON.stringify(evidence));
  let launches=0,checks=0,oldInput,mode='unknown',ownerRuntime='orca';
  const seen=[];
  const receiptFor=input=>{const identity={sessionId:input.args.attempt===1?'old':'new',incarnationId:input.args.attempt===1?'old-1':'new-1',cwd:root};return {...identity,task:{...identity,schema:'harness.goal-receipt/1',effectKey:input.key,promptDigest:taskDigest('prompt'),goalDigest:input.args.goalDigest,goal:{threadId:'thread',status:'active',objective:'prompt'},threadId:'thread',turnId:'turn',activityId:'activity',packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};};
  const session={observe:async()=>({...startRequest.parentRuntime,runtime:ownerRuntime}),async execute(input){launches++;
    if(input.args.attempt>1)return receiptFor(input);
    oldInput=input;
    if(submitted){const binding={...receiver,goalDigest:input.args.goalDigest,promptDigest:taskDigest('prompt'),packets:['handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))};await input.submission.mark(binding);await input.submission.confirm(binding);}
    throw Error('authentication failed before task start');},
    async verify(input){checks++;seen.push(input);if(mode==='completed'||input.args.attempt>1)return {status:'completed',result:receiptFor(input)};return {status:'unknown',verify:{code:'SESSION_TASK_UNVERIFIED'}};}};
  const provider={verifyUserInput:async binding=>({...binding,verified:binding.userInputRef==='actual-instruction'}),
    async verifySessionStartRecovery({request,intent,submission,original,goal,nextArgs,...binding}){
      assert.equal(original.policy.account,'/old-account');assert.equal(intent.args.goalDigest,oldInput.args.goalDigest);
      assert.equal(goal.policy.account,'/new-account');assert.equal(nextArgs.attempt,intent.args.attempt+1);
      if(submitted)assert.equal(submission.binding.threadId,'original-thread');
      const bytes=await readFile(request.provenance.path);const evidence=JSON.parse(bytes);
      return {...binding,verified:true,...evidence,evidenceDigest:hash(bytes)};
    }};
  const adapters={session,provider,now:()=> '2026-01-01T00:00:00Z'};
  const start=()=>startGoalSession({stateRoot:root,unit:'u',request:startRequest,store,adapters});
  assert.equal((await start()).status,'uncertain');
  const rows=()=>ledgerStore.withLock('u',l=>l.read());
  const intent=(await rows()).find(row=>row.event==='intent');
  await goals.transaction('g',goal=>({...goal,revision:goal.revision+1,policy:{...policy,provider:'codex',account:'/new-account',argv:['codex']},policyChanges:[{previous:policy,reason:'authorized account change',userInputRef:'actual-instruction'}]}));
  const request={id:'recovery-1',expectedRevision:1,expectedGoalRevision:2,intent:{key:intent.key,seq:intent.seq,argsDigest:effectArgsDigest(intent.args)},provenance:{path:provenancePath,digest:hash(await readFile(provenancePath))},reason:'Authorized same-unit restart with new account'};
  const recover=(patch={})=>recoverGoalSession({stateRoot:root,unit:'u',request,userInputRef:'actual-instruction',store,adapters,...patch});
  return {root,goals,store,ledgerStore,adapters,request,startRequest,intent,rows,start,recover,seen,get launches(){return launches;},get checks(){return checks;},set mode(value){mode=value;},set ownerRuntime(value){ownerRuntime=value;}};
}

test('AC-1 policy refresh preserves complete original args for uncertain observation and eventual receipt registration',async t=>{
  const f=await fixture(t);
  const pending=await f.start();assert.equal(pending.status,'uncertain');
  assert.deepEqual(pending.intent,f.request.intent);
  assert.equal(f.launches,1);assert.deepEqual(f.seen.at(-1).args,f.intent.args);
  f.mode='completed';assert.equal((await f.start()).status,'reconciled');
  const goal=await f.goals.read('g');assert.equal(goal.bootstraps[0].goalDigest,f.intent.args.goalDigest);assert.equal(goal.policy.account,'/new-account');
  assert.equal((await f.start()).status,'duplicate');assert.equal(f.launches,1);
  await assert.rejects(f.recover(),{code:'EFFECT_UNCERTAIN'});
});

test('AC-2 public recovery reserves one durable new attempt and start survives replay without rewriting history',async t=>{
  const f=await fixture(t),before=await f.rows(),unitBefore=await f.store.read('u');
  const requestFile=path.join(f.root,'recover.json');await writeFile(requestFile,JSON.stringify(f.request));
  const output=result(await runUnitCli(['unit','session-recover','u','--request',requestFile,'--user-input','actual-instruction'],{stateRoot:f.root,adapters:f.adapters}));
  assert.equal(output.code,0,JSON.stringify(output));assert.equal(f.launches,1);
  const receipt=output.receipt;assert.equal(receipt.nextArgs.attempt,2);assert.notEqual(receipt.nextKey,f.intent.key);
  const launch=await loadManagedLaunch(receipt.nextArgs);assert.equal(launch.env.CODEX_HOME,'/new-account');
  const after=await f.rows();assert.deepEqual(after.slice(0,before.length),before);assert.equal(after.filter(row=>row.event==='result').length,0);
  assert.deepEqual(await f.store.read('u'),unitBefore);
  assert.equal(f.seen.at(-1).submission.readOnly,true);
  assert.equal((await f.recover()).duplicate,true);
  assert.equal((await f.start()).status,'completed');assert.equal(f.launches,2);
  assert.equal((await f.start()).status,'duplicate');assert.equal(f.launches,2);
  assert.equal((await f.recover()).duplicate,true);
  assert.equal((await f.goals.read('g')).bootstraps[0].attempt,2);
  assert.equal(decideResume({record:await f.store.read('u'),ledger:await f.rows()}).action,'inspect-git');
  let called=false;
  await assert.rejects(executeEffect({unit:'u',effect:'session.start',args:f.intent.args,policy:{goal:{class:'product-prelaunch'}},context:{productOwned:true},store:f.ledgerStore,
    adapter:{now:f.adapters.now,execute:async()=>{called=true;},verify:async()=>{called=true;}}}),{code:'EFFECT_RETIRED'});
  assert.equal(called,false);
  assert.equal(sessionStartRetired(await f.rows(),f.intent),true);
  assert.equal((await f.rows()).filter(row=>row.event==='session-start-recovery').length,1);
});

test('a changed request cannot consume the reserved attempt or change a recovery ID binding',async t=>{
  const f=await fixture(t);await f.recover();
  await assert.rejects(f.recover({request:{...f.request,reason:'different'}}),{code:'SESSION_RECOVERY_CONFLICT'});
  const handoff=path.join(f.root,'other.md');await writeFile(handoff,await readFile(f.startRequest.handoffPath));
  await assert.rejects(startGoalSession({stateRoot:f.root,unit:'u',request:{...f.startRequest,handoffPath:handoff},store:f.store,adapters:f.adapters}),{code:'EFFECT_UNCERTAIN'});
  assert.equal(f.launches,1);assert.equal((await f.start()).status,'completed');assert.equal(f.launches,2);
});

test('recovery denies stale, untrusted, successful and ambiguous inputs without reserving a new worker',async t=>{
  const cases={
    'stale unit':async f=>{f.request.expectedRevision++;},
    'stale goal':async f=>{f.request.expectedGoalRevision++;},
    'changed intent args':async f=>{f.request.intent.argsDigest=hash('other');},
    'unapproved input':async f=>{f.adapters.provider.verifyUserInput=async input=>({...input,verified:false});},
    'missing native verifier':async f=>{delete f.adapters.provider.verifySessionStartRecovery;},
    'unavailable old account':async f=>{f.adapters.provider.verifySessionStartRecovery=async()=>{throw Error('original account unavailable');};},
    'hidden completed receipt':async f=>{f.mode='completed';},
    'registered owner':async f=>{await f.goals.transaction('g',g=>({...g,revision:g.revision+1,bootstraps:[{unit:'u'}]}));f.request.expectedGoalRevision++;},
    'unchanged policy':async f=>{await f.goals.transaction('g',g=>({...g,revision:g.revision+1,policy:g.policyChanges[0].previous}));f.request.expectedGoalRevision++;},
    'changed source':async f=>{await writeFile(path.join(f.root,'goal.md'),'changed');},
    'changed handoff':async f=>{await writeFile(f.startRequest.handoffPath,'changed');},
    'changed native proof':async f=>{await writeFile(f.request.provenance.path,'changed');},
    'another uncertain effect':async f=>{await f.ledgerStore.withLock('u',l=>l.append({event:'intent',effect:'git.commit',key:'other',seq:2,args:{}}));},
    'missing user ref':async f=>{f.recover=()=>recoverGoalSession({stateRoot:f.root,unit:'u',request:f.request,store:f.store,adapters:f.adapters});},
    'next policy during recovery':async f=>{const verify=f.adapters.provider.verifySessionStartRecovery;f.adapters.provider.verifySessionStartRecovery=async input=>{await assert.rejects(f.goals.transaction('g',g=>({...g,revision:g.revision+1})),{code:'GOAL_LOCKED'});return {...await verify(input),verified:false};};},
  };
  for(const field of ['verified','taskNeverStarted','receiverStopped','queueCancelled','goalDigest','nextArgsDigest','evidenceDigest','receiver']) cases[`invalid proof ${field}`]=async f=>{
    const verify=f.adapters.provider.verifySessionStartRecovery;
    f.adapters.provider.verifySessionStartRecovery=async input=>({...await verify(input),[field]:field==='receiver'?{...input.submission.binding,threadId:'foreign'}:false});
  };
  for(const [name,mutate] of Object.entries(cases)) await t.test(name,async t=>{
    const f=await fixture(t);await mutate(f);await assert.rejects(f.recover());
    assert.equal(f.launches,1);assert.equal((await f.rows()).filter(row=>row.event==='session-start-recovery').length,0);
  });
});

test('AC-3 concurrent recoveries reserve once and concurrent starts launch the reservation once',async t=>{
  const f=await fixture(t);
  const recovered=await Promise.all([f.recover(),f.recover()]);assert.equal(recovered.filter(row=>row.duplicate).length,1);
  const started=await Promise.all([f.start(),f.start()]);assert.deepEqual(started.map(row=>row.status).sort(),['completed','duplicate']);
  assert.equal(f.launches,2);assert.equal((await f.rows()).filter(row=>row.event==='intent').length,2);
});

test('start holds goal custody through re-observation and registration, blocking a concurrent policy refresh',async t=>{
  const f=await fixture(t);let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),released=new Promise(resolve=>{release=resolve;});
  const verify=f.adapters.session.verify;f.adapters.session.verify=async input=>{enter();await released;return verify(input);};
  const running=f.start();await entered;
  await assert.rejects(f.goals.transaction('g',g=>({...g,revision:g.revision+1,policy:{...g.policy,account:'/racing-account'}})),{code:'GOAL_LOCKED'});
  release();assert.equal((await running).status,'uncertain');assert.equal(f.launches,1);
});

test('old-runtime observation survives a runtime change; recovery binds a new runtime without changing the old intent',async t=>{
  const f=await fixture(t,{submitted:false});
  await f.goals.transaction('g',g=>({...g,revision:g.revision+1,policy:{...g.policy,runtime:'cmux'}}));f.request.expectedGoalRevision++;
  assert.equal((await f.start()).status,'uncertain');
  await f.recover();f.ownerRuntime='cmux';assert.equal((await f.start()).status,'completed');
  assert.equal((await f.rows()).find(row=>row.event==='intent').args.goalDigest,f.intent.args.goalDigest);
});

test('a later stop/resume advances beyond the recovered attempt and observes the new policy snapshot',async t=>{
  const f=await fixture(t);await f.recover();await f.start();
  // Recovery-store resume archives the ended managed session; recovery reservations do not fabricate that history.
  await f.store.update('u',record=>({...record,sessionHistory:[{owner:{sessionId:'new'},status:'stopped'}]}));
  assert.equal((await f.start()).status,'completed');assert.equal(f.launches,3);
  assert.equal((await f.rows()).filter(row=>row.event==='intent').at(-1).args.attempt,3);
  assert.equal((await f.goals.read('g')).bootstraps.at(-1).attempt,3);
  assert.equal((await f.start()).status,'duplicate');assert.equal(f.launches,3);
});

test('the shipped executable loads trusted recovery providers and reserves without launching',async t=>{
  const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
  const f=await fixture(t),requestFile=path.join(f.root,'recover.json'),permissionFile=path.join(f.root,'permission.json');
  await writeFile(requestFile,JSON.stringify(f.request));
  await writeFile(permissionFile,JSON.stringify({effect:'unit.session.recover',argsDigest:effectArgsDigest({request:f.request,userInputRef:'actual-instruction'}),userInputRef:'actual-instruction'}));
  const stub=path.join(f.root,'native.mjs'),adapter=path.join(f.root,'runtime.mjs');
  await writeFile(stub,`
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const bytes=await readFile(${JSON.stringify(f.request.provenance.path)});
process.stdout.write(JSON.stringify({...JSON.parse(bytes),evidenceDigest:'sha256:'+createHash('sha256').update(bytes).digest('hex')}));
`);
  await writeFile(adapter,`
import {readFile} from 'node:fs/promises';
export async function createRuntimeAdapters({adapters}) {return {provider:{
async verifyUserInput(binding){const permission=JSON.parse(await readFile(${JSON.stringify(permissionFile)}));return {...binding,verified:Object.entries(permission).every(([key,value])=>binding[key]===value)};},
async verifySessionStartRecovery({request,intent,submission,original,goal,nextArgs,...binding}){
if(original.policy.account!=='/old-account'||goal.policy.account!=='/new-account')throw Error('account mismatch');
const observed=await adapters.command(process.execPath,[${JSON.stringify(stub)}],{cwd:${JSON.stringify(f.root)}});
if(observed.exitCode!==0)throw Error('native observation unavailable');
return {...binding,...JSON.parse(observed.stdout),verified:true};
}}};}
`);
  const cli=fileURLToPath(new URL('./unit.mjs',import.meta.url));
  const args=[cli,'unit','session-recover','u','--request',requestFile,'--user-input','actual-instruction','--state-root',f.root,'--project-root',f.root,'--adapters',adapter];
  for(let attempt=0;attempt<2;attempt++){
    const run=spawnSync(process.execPath,args,{cwd:f.root,encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
    assert.equal(Boolean(result(run.stdout.trim()).receipt.duplicate),attempt===1);
  }
  assert.equal(f.launches,1);assert.equal((await f.rows()).filter(row=>row.event==='session-start-recovery').length,1);
});
