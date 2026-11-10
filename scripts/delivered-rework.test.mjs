import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,rename,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore,sessionEffectRetired} from './lib/ledger.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {reopenDelivered} from './lib/delivered-rework.mjs';
import {prepareEffect} from './lib/policy.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'delivered-rework-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createUnitStateStore(root), ledger=createLedgerStore(root), goals=createContinuityStore(root);
  const provenance=path.join(root,'evidence.txt'), bytes='native evidence'; await writeFile(provenance,bytes);
  const source={path:provenance,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
  await goals.create({goal:{id:'g',objective:'goal',criteria:['before'],remaining:['u'],status:'active'},
    policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source});
  const plan={owner:{sessionId:'owner',incarnationId:'owner-1',cwd:root},recipient:{sessionId:'recipient'},resultDigest:'result'};
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Delivered',continuity:{goalId:'g'},
    accepted:{head:'a',contentFingerprint:'tree'},deliveryResult:{level:'push',head:'a'},sessionFinalization:plan,
    goalCompletion:{goalId:'g',revision:1,proof:[]},acceptance:[{id:'AC-1',text:'before'}],
    evidence:[{gate:'tests',status:'passed',covers:['AC-1']}],reviewDecision:{verdict:'ship'},stages:[]});
  const args={session:'recipient',incarnation:'recipient-1',resultDigest:'result'};
  const intent={event:'intent',effect:'session.deliver',seq:4,key:prepareEffect('session.deliver',args).key,args};
  await ledger.withLock('u',l=>l.append(intent));
  const request={id:'fix',expectedRevision:1,expectedGoalRevision:1,intent:{seq:4,key:intent.key,argsDigest:effectArgsDigest(intent.args)},
    provenance:source,acceptance:[{id:'AC-1',text:'before'},{id:'AC-2',text:'after'}],reason:'approved correction'};
  const target={head:'a',contentFingerprint:'tree'};
  const adapters={now:()=> 'time',git:{inspectUnit:async()=>target},provider:{verifyUserInput:async x=>({...x,verified:true}),
    verifyDeliveredRework:async x=>({...x,verified:true,finalizerStopped:true,oldExecutionFenced:true,queueSettled:true,ownerAlive:true,deliveryVerified:true,owner:x.record.sessionFinalization.owner,evidenceDigest:source.digest})}};
  const run=(changes={})=>reopenDelivered({stateRoot:root,store,unit:'u',request,userInputRef:'actual-user',adapters,...changes});
  return {root,store,ledger,intent,request,adapters,run};
}

test('AC-1: verified delivered rework preserves original evidence and retires only its exact delivery',async t=>{
  const f=await fixture(t); const receipt=await f.run(); const next=await f.store.read('u');
  assert.equal(next.state,'Implementing'); assert.equal(next.accepted,null); assert.equal(next.deliveryResult,null);
  assert.equal(next.acceptance[1].text,'after'); assert.equal(next.evidence[0].status,'stale');
  assert.equal(next.deliveredRework[0].previous.deliveryResult.level,'push');
  assert.equal(next.deliveredRework[0].previous.evidence[0].status,'passed');
  const rows=await f.ledger.withLock('u',l=>l.read()); assert.equal(sessionEffectRetired(rows,f.intent),true);
  assert.equal((await f.run()).duplicate,true); assert.equal((await f.store.read('u')).revision,2);
  assert.equal(receipt.seq,4);
});

test('AC-1: missing fencing, stale target and changed criteria refuse without a receipt',async t=>{
  for(const missing of ['finalizerStopped','oldExecutionFenced','queueSettled','ownerAlive','deliveryVerified','owner']) {
    const f=await fixture(t); const original=f.adapters.provider.verifyDeliveredRework;
    f.adapters.provider.verifyDeliveredRework=async x=>({...await original(x),[missing]:false});
    await assert.rejects(f.run(),{code:'DELIVERED_REWORK_UNPROVEN'});
    assert.equal((await f.store.read('u')).state,'Delivered'); assert.equal((await f.ledger.withLock('u',l=>l.read())).length,1);
  }
  const f=await fixture(t); f.adapters.git.inspectUnit=async()=>({head:'changed',contentFingerprint:'tree'});
  await assert.rejects(f.run(),{code:'CONTINUITY_STALE'});
});

test('AC-1: a persisted checkpoint recovers after a unit write interruption without a second checkpoint',async t=>{
  const f=await fixture(t);
  const broken={...f.store,update:async(unit,mutate)=>f.store.withLock(unit,async record=>{await mutate(record);throw new Error('disk fault');})};
  await assert.rejects(f.run({store:broken}),/disk fault/); assert.equal((await f.store.read('u')).state,'Delivered');
  assert.equal((await f.ledger.withLock('u',l=>l.read())).filter(x=>x.event==='delivered-rework').length,1);
  const goals=createContinuityStore(f.root);
  await assert.rejects(goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['u','later']}})),{code:'GOAL_REWORKING'});
  f.adapters.git.inspectUnit=async()=>({head:'new',contentFingerprint:'new-tree'});
  delete f.adapters.provider.verifyDeliveredRework;
  delete f.adapters.provider.verifyUserInput;
  await f.run(); assert.equal((await f.store.read('u')).state,'Implementing');
  assert.equal((await f.store.read('u')).deliveredRework[0].previous.accepted.head,'a');
  assert.equal((await goals.read('g')).reworkReservation,undefined);
  assert.equal((await f.ledger.withLock('u',l=>l.read())).filter(x=>x.event==='delivered-rework').length,1);
});

test('AC-1: retry clears the same goal reservation after the unit was recorded',async t=>{
  const f=await fixture(t); const receipt=await f.run(); const goals=createContinuityStore(f.root);
  await goals.transaction('g',g=>({...g,revision:g.revision+1,reworkReservation:{unit:'u',requestDigest:receipt.requestDigest,unitDigest:receipt.recordDigest,checkpoint:receipt}}));
  assert.equal((await f.run()).duplicate,true);
  assert.equal((await goals.read('g')).reworkReservation,undefined);
  assert.equal((await f.store.read('u')).revision,2);
});

test('AC-1: reserved rework resumes if ledger checkpoint creation fails',async t=>{
  const f=await fixture(t), ledgerFile=path.join(f.root,'units','u','ledger.ndjson'), backup=`${ledgerFile}.backup`;
  const original=f.adapters.provider.verifyDeliveredRework;
  f.adapters.provider.verifyDeliveredRework=async input=>{const proof=await original(input);await rename(ledgerFile,backup);await mkdir(ledgerFile);return proof;};
  await assert.rejects(f.run());
  const goals=createContinuityStore(f.root);
  assert.ok((await goals.read('g')).reworkReservation);
  await assert.rejects(goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['u','later']}})),{code:'GOAL_REWORKING'});
  await rm(ledgerFile,{recursive:true});await rename(backup,ledgerFile);
  f.adapters.provider.verifyDeliveredRework=original;
  f.adapters.git.inspectUnit=async()=>({head:'new',contentFingerprint:'new-tree'});
  await f.run();
  assert.equal((await f.store.read('u')).state,'Implementing');
  assert.equal((await goals.read('g')).reworkReservation,undefined);
});

test('AC-1: existing dropped criteria remain dropped during rework',async t=>{
  const f=await fixture(t);
  await f.store.update('u',record=>({...record,acceptance:[{...record.acceptance[0],status:'dropped'}]}));
  f.request.expectedRevision=2;
  await f.run();
  const record=await f.store.read('u');
  assert.equal(record.acceptance[0].status,'dropped');
  const {productAcceptance}=await import('./lib/acceptance-correction.mjs');
  assert.deepEqual(productAcceptance(record).map(item=>item.id),['AC-2']);
});

test('AC-2: goal amendment cannot cross the live close effect boundary',async t=>{
  const f=await fixture(t); const {fenceGoalClose}=await import('./lib/continuity-completion.mjs');
  const goals=createContinuityStore(f.root);
  // The close fence validates the accepted criterion before permitting the effect.
  await f.store.update('u',r=>({...r,evidence:[{gate:'tests',status:'passed',exit:0,covers:['AC-1']}],goalCompletion:{goalId:'g',revision:1,proof:[{criterion:'before',unit:'u',acceptance:'AC-1'}]}}));
  const current=await f.store.read('u'); let enter,release;
  const entered=new Promise(r=>enter=r), wait=new Promise(r=>release=r); t.after(()=>release());
  const closing=fenceGoalClose({continuityStore:goals,unitStore:f.store,unit:'u',plan:current.sessionFinalization,completion:current.goalCompletion,
    action:async()=>{enter();await wait;}});
  await entered;
  await assert.rejects(goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['u','new']}})),e=>['GOAL_LOCKED','GOAL_LOCK_UNAVAILABLE','GOAL_COMPLETING'].includes(e.code));
  release(); await closing;
  assert.deepEqual((await goals.read('g')).goal.remaining,['u']);
  // The reservation stays in force after the irreversible effect and permits the same finalizer to resume.
  await assert.rejects(goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['u','new']}})),{code:'GOAL_COMPLETING'});
  await fenceGoalClose({continuityStore:goals,unitStore:f.store,unit:'u',plan:current.sessionFinalization,completion:current.goalCompletion,action:async()=>{}});
});

test('AC-1: delivery obligations survive rework and cannot be weakened', async () => {
  const {assertDeliveryObligations} = await import('./lib/acceptance-correction.mjs');
  const record = {acceptanceCorrections: [], inheritedDeliveryObligations: [
    {acceptanceRef:'AC-5',kind:'delivery',owner:'engine',level:'push'}
  ]};
  assert.throws(() => assertDeliveryObligations(record,'none'), {code:'DELIVERY_OBLIGATION_REQUIRED'});
  assert.throws(() => assertDeliveryObligations(record,'commit'), {code:'DELIVERY_OBLIGATION_REQUIRED'});
  assert.doesNotThrow(() => assertDeliveryObligations(record,'push'));
  const external = {acceptanceCorrections: [], inheritedDeliveryObligations: [
    {acceptanceRef:'AC-6',kind:'delivery',owner:'external',level:'push'}
  ]};
  assert.throws(() => assertDeliveryObligations(external,'merge'), {code:'DELIVERY_OBLIGATION_REQUIRED'});
});

test('AC-1: previously approved criteria cannot be rewritten during rework', async t => {
  const f = await fixture(t);
  f.request.acceptance[0].text = 'weakened';
  await assert.rejects(f.run(), {code:'DELIVERED_REWORK_INVALID'});
  assert.equal((await f.store.read('u')).state,'Delivered');
});

test('AC-1: verified existing push obligation remains mandatory after rework', async t => {
  const f=await fixture(t);
  const {correctionSource,assertDeliveryObligations}=await import('./lib/acceptance-correction.mjs');
  const before=await f.store.read('u');
  const correction={id:'delivery',expectedRevision:1,acceptanceRef:'AC-1',criterionDigest:effectArgsDigest(before.acceptance[0]),
    sourceDigest:effectArgsDigest(correctionSource(before)),head:'a',contentFingerprint:'tree',kind:'delivery',
    provenance:{ref:'user-source',digest:'sha256:'+'1'.repeat(64)},reason:'delivery obligation',level:'push',owner:'engine'};
  const userInputRef='original-user', receipt={request:correction,userInputRef,requestDigest:effectArgsDigest({request:correction,userInputRef})};
  await f.store.update('u',r=>({...r,acceptanceCorrections:[receipt]}));
  f.request.expectedRevision=2;
  f.adapters.provider.verifyAcceptanceCorrection=async input=>({...input,verified:true});
  const broken={...f.store,update:async(unit,mutate)=>f.store.withLock(unit,async record=>{await mutate(record);throw new Error('disk fault');})};
  await assert.rejects(f.run({store:broken}),/disk fault/);
  f.adapters.git.inspectUnit=async()=>({head:'new',contentFingerprint:'new-tree'});
  await f.run();
  const after=await f.store.read('u');
  assert.equal(after.inheritedDeliveryObligations[0].level,'push');
  assert.throws(()=>assertDeliveryObligations(after,'commit'),{code:'DELIVERY_OBLIGATION_REQUIRED'});
  assert.doesNotThrow(()=>assertDeliveryObligations(after,'push'));
});

test('AC-1: public rework command records the authorized recovery on the same unit',async t=>{
  const f=await fixture(t),requestFile=path.join(f.root,'request.json');
  await writeFile(requestFile,JSON.stringify(f.request));
  const {runUnitCli}=await import('./lib/unit-driver.mjs');
  const output=await runUnitCli(['unit','rework','u','--request',requestFile,'--user-input','actual-user'],{stateRoot:f.root,cwd:f.root,adapters:f.adapters});
  assert.match(output,/RESULT \{"code":0/);
  assert.equal((await f.store.read('u')).state,'Implementing');
});

test('AC-1: target drift after reservation still runs stage restart and reports an out-of-scope change',async t=>{
  const {execFileSync}=await import('node:child_process');
  const {createAdapters}=await import('./lib/adapters.mjs');
  const {runUnitCli}=await import('./lib/unit-driver.mjs');
  const cwd=await mkdtemp(path.join(os.tmpdir(),'rework-scope-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  await writeFile(path.join(cwd,'source'),'base');await writeFile(path.join(cwd,'outside'),'base');git('add','.');git('commit','-qm','base');
  const initial=git('rev-parse','HEAD'),stateRoot=path.join(cwd,'.git/work-state'),store=createUnitStateStore(stateRoot);
  const adapters={...createAdapters({repositoryRoot:cwd})};
  adapters.git={inspectUnit:async()=>{const head=git('rev-parse','HEAD');return {head,contentFingerprint:`sha256:${createHash('sha256').update(head).digest('hex')}`};}};
  adapters.gates={describe:async id=>({id,command:[process.execPath,'-e',`console.log(JSON.stringify({ok:true,covers:['AC-1','AC-2']}))`],format:'exec',resultFormat:'json',files:[{path:'source',content:await readFile(path.join(cwd,'source'),'utf8')},{path:'outside',content:await readFile(path.join(cwd,'outside'),'utf8')}]})};
  const call=async args=>{const out=await runUnitCli(args,{cwd,stateRoot,adapters});return JSON.parse(out.slice(out.lastIndexOf('RESULT ')+7));};
  await store.create({schema:'harness.unit/1',unit:'demo',kind:'impl',state:'Implementing',request:'work',policy:{goal:{class:'task'},delivery:'none',review:{mode:'none'}},scopePaths:['source'],
    head:initial,contentFingerprint:'',stages:[],acceptance:[{id:'AC-1',text:'implement'}],evidence:[],findings:[],failures:[],assumptions:[],openDecisions:[],canon:[],feedback:[]});
  const opened=await call(['unit','stage','open','demo','implement']);assert.equal(opened.code,0,JSON.stringify(opened));
  const input=JSON.parse(await readFile(opened.input,'utf8'));await writeFile(path.join(cwd,'source'),'implemented');
  const output=path.join(cwd,'.git/output.json');
  await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'first',status:'done',summary:'implemented',changedPaths:['source'],coverage:[],assumptions:[],openDecisions:[]}));
  assert.equal((await call(['unit','stage','submit','demo','implement','--output',output])).code,0);
  git('add','source');git('commit','-qm','implementation');
  const record=await store.read('demo'),target=await adapters.git.inspectUnit({unit:'demo',record});
  const goalFile=path.join(cwd,'.git/goal.md'),bytes='goal';await writeFile(goalFile,bytes);
  const provenance={path:goalFile,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
  const goals=createContinuityStore(stateRoot);
  await goals.create({goal:{id:'g',objective:'goal',criteria:['implement'],remaining:['demo'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:provenance});
  const owner={sessionId:'owner',incarnationId:'owner-1',cwd},plan={owner,recipient:{sessionId:'recipient'},resultDigest:'result'};
  await store.update('demo',r=>({...r,state:'Delivered',head:target.head,accepted:target,deliveryResult:{level:'push',head:target.head},sessionFinalization:plan,continuity:{goalId:'g'}}));
  const args={session:'recipient',incarnation:'recipient-1',resultDigest:'result'},intent={event:'intent',effect:'session.deliver',seq:4,key:prepareEffect('session.deliver',args).key,args};
  await createLedgerStore(stateRoot).withLock('demo',l=>l.append(intent));
  const before=await store.read('demo');
  const request={id:'rework',expectedRevision:before.revision,expectedGoalRevision:1,intent:{seq:intent.seq,key:intent.key,argsDigest:effectArgsDigest(args)},provenance,
    acceptance:[{id:'AC-1',text:'implement'},{id:'AC-2',text:'new work'}],reason:'approved rework'};
  adapters.provider={verifyUserInput:async x=>({...x,verified:true}),verifyDeliveredRework:async x=>({...x,verified:true,finalizerStopped:true,oldExecutionFenced:true,queueSettled:true,ownerAlive:true,deliveryVerified:true,owner,evidenceDigest:provenance.digest})};
  const broken={...store,update:async(unit,mutate)=>store.withLock(unit,async current=>{await mutate(current);throw new Error('disk fault');})};
  await assert.rejects(reopenDelivered({stateRoot,store:broken,unit:'demo',request,userInputRef:'approved',adapters}),/disk fault/);
  await writeFile(path.join(cwd,'outside'),'unexpected');git('add','outside');git('commit','-qm','unexpected change');
  const requestFile=path.join(cwd,'.git/request.json');await writeFile(requestFile,JSON.stringify(request));
  assert.equal((await call(['unit','rework','demo','--request',requestFile,'--user-input','approved'])).code,0);
  assert.equal((await call(['unit','stage','open','demo','implement'])).error,'CHECKPOINT_STALE');
  const prior=(await store.read('demo')).stages.find(stage=>stage.name==='implement').attempts[0];
  await writeFile(requestFile,JSON.stringify({attempt:prior.n,inputDigest:prior.inputDigest,checkpointHead:prior.checkpointHead,newHead:git('rev-parse','HEAD')}));
  const restarted=await call(['unit','stage','restart','demo','implement','--request',requestFile]);assert.equal(restarted.code,0,JSON.stringify(restarted));
  const reopened=await call(['unit','stage','open','demo','implement']);assert.equal(reopened.code,0,JSON.stringify(reopened));
  const next=JSON.parse(await readFile(reopened.input,'utf8'));
  await writeFile(output,JSON.stringify({inputDigest:next.inputDigest,attempt:next.attempt,submissionId:'rework',status:'done',summary:'reworked',changedPaths:[],coverage:[],assumptions:[],openDecisions:[]}));
  assert.equal((await call(['unit','stage','submit','demo','implement','--output',output])).code,0);
  const after=await store.read('demo');assert.ok(after.findings.some(item=>item.kind==='scope-guard'&&item.severity==='must-fix'&&item.paths.includes('outside')));
  const accepted=await call(['unit','accept','demo']);assert.equal(accepted.code,1,JSON.stringify(accepted));
  assert.match(accepted.reason,/unresolved must-fix findings/);
  assert.equal(git('show','HEAD:outside'),'unexpected');
});

test('AC-2: pending rework reservation prevents a new stale result delivery',async t=>{
  const f=await fixture(t), goals=createContinuityStore(f.root), record=await f.store.read('u');
  await goals.transaction('g',goal=>({...goal,revision:goal.revision+1,reworkReservation:{unit:'u',requestDigest:'sha256:'+'a'.repeat(64)}}));
  const {fenceGoalDelivery}=await import('./lib/continuity-completion.mjs'); let calls=0;
  await assert.rejects(fenceGoalDelivery({continuityStore:goals,unitStore:f.store,unit:'u',plan:record.sessionFinalization,action:async()=>{calls++;}}),{code:'GOAL_REWORKING'});
  assert.equal(calls,0);
});
