import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAdapters } from './lib/adapters.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest as digest } from './lib/approvals.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const parse = value => JSON.parse(value.slice(value.lastIndexOf('RESULT ')+7));
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(),'policy-recovery-'))); t.after(() => rm(cwd,{recursive:true,force:true}));
  const stateRoot = path.join(cwd,'state'), goals = createContinuityStore(stateRoot), store = createUnitStateStore(stateRoot), ledger = createLedgerStore(stateRoot);
  const policy = {runtime:'cmux',provider:'codex',account:'/personal',model:'model',effort:'high',argv:['codex']};
  const badPolicy = {...policy,account:'/company',roles:{review:{account:'/personal',effort:'medium'}}};
  const source = {path:path.join(cwd,'goal.md'),digest:hash('goal')}; await writeFile(source.path,'goal');
  await goals.create({goal:{id:'goal',objective:'work',criteria:['verified'],remaining:['change'],status:'active'},source,policy});
  const owner = {runtime:'cmux',sessionId:'owner',incarnationId:'owner-v1',cwd,worker:{pid:42,threadId:'native-owner',executable:'/bin/codex',incarnationId:'worker-v1'}};
  const custody = {id:'original',unit:'change',ownership:'existing',owner,...owner,policyDigest:digest(policy),userInputRef:'original-work'};
  const change = {revision:3,previous:policy,reason:'mistaken project defaults refresh',userInputRef:'operational-relay'};
  await goals.transaction('goal',g => ({...g,revision:g.revision+1,adoptions:[custody],transfers:[{unit:'old',successor:'change'}],amendments:[{previous:{criteria:['old']}}]}));
  await goals.transaction('goal',g => ({...g,revision:g.revision+1,policy:badPolicy,policyChanges:[change]}));
  const target = {head:'head',contentFingerprint:'content',repo:cwd};
  await store.create({schema:'harness.unit/1',unit:'change',kind:'chore',state:'InReview',continuity:{goalId:'goal'},continuityRequired:true,
    request:{text:'work',userInputRef:'original-work'},policy:{goal:{class:'task'},session:policy,review:{mode:'required',by:'session',triggers:[]},delivery:'none'},
    head:target.head,contentFingerprint:target.contentFingerprint,stages:[{name:'implement',attempt:1,submittedAt:'earlier'}],
    acceptance:[{id:'AC-1',text:'verified'}],evidence:[{gate:'tests',status:'passed',covers:['AC-1']}],failures:[{signature:'old-error'}],
    accepted:null,reviewDecision:{required:true,head:target.head},canon:[],scopePaths:['src/']});
  await ledger.withLock('change',l => l.append({event:'historical-failure',message:'preserve me'}));
  const provenance = {path:path.join(cwd,'proof.json'),digest:hash('original human context and native account proof')};
  await writeFile(provenance.path,'original human context and native account proof');
  const record = await store.read('change'), goal = await goals.read('goal');
  const request = {id:'restore-policy',unit:'change',expectedRevision:goal.revision,expectedUnitRevision:record.revision,goalDigest:digest(goal),unitDigest:digest(record),
    targetDigest:digest(target),changeRevision:change.revision,changeDigest:digest(change),owner,provenance,reason:'Restore independently authorized personal high policy; preserve the erroneous row'};
  let live = owner, liveTarget = target, authorized = true, proofOverride = {}, hook = async () => {};
  const adapters = {...createAdapters({repositoryRoot:cwd}),git:{inspectUnit:async () => liveTarget},session:{observe:async () => live},
    provider:{verifyUserInput:async b => ({...b,verified:authorized && b.userInputRef === 'original-human' && b.effect === 'goal.policy.recover'}),
      async verifyPolicyRefreshRecovery(input) {
        const {request:r,goal:g,record:u,target:tar,observation,custody:c,change:ch,...binding} = input;
        assert.equal(digest(ch),digest(change)); assert.equal(digest(g),request.goalDigest); assert.equal(digest(u),request.unitDigest);
        assert.equal(digest(tar),request.targetDigest); assert.equal(digest(c),digest(custody)); assert.deepEqual(observation,owner);
        assert.equal(binding.rejectedUserInputRef,'operational-relay'); assert.equal(binding.restoredPolicyDigest,digest(policy)); assert.equal(binding.rejectedPolicyDigest,digest(badPolicy));
        await hook();
        return {...binding,verified:authorized && r.provenance.path === provenance.path,originalAuthority:true,currentPolicyUnauthorized:true,priorPolicyAuthorized:true,
          nativeExecutionVerified:true,evidenceDigest:provenance.digest,...proofOverride};
      }}};
  const run = async (r=request,ref='original-human') => {
    const file = path.join(cwd,`${r.id}.json`); await writeFile(file,JSON.stringify(r));
    return parse(await runUnitCli(['goal','policy-recover','goal','--request',file,'--user-input',ref],{cwd,stateRoot,adapters}));
  };
  return {cwd,stateRoot,goals,store,ledger,source,policy,badPolicy,target,owner,request,run,adapters,
    deny:()=>{authorized=false;},proof:value=>{proofOverride=value;},hook:value=>{hook=value;},targetChange:()=>{liveTarget={...target,head:'changed'};},ownerChange:()=>{live={...owner,incarnationId:'other'};}};
}

test('AC-2 AC-3 public policy recovery restores authorized prior policy and preserves every historical field and effect',async t => {
  const f = await fixture(t), before = await f.goals.read('goal'), unit = await f.store.read('change');
  const ledgerPath = path.join(f.stateRoot,'units/change/ledger.ndjson'), bytes = await readFile(ledgerPath);
  const result = await f.run(); assert.equal(result.code,0,JSON.stringify(result));
  const after = await f.goals.read('goal'); assert.deepEqual(after.policy,f.policy); assert.equal(after.revision,before.revision+1);
  assert.deepEqual(after.policyChanges.slice(0,-1),before.policyChanges); assert.equal(after.policyChanges.at(-1).supersedesRevision,3);
  const {policy,revision,policyChanges,policyRecoveries,...unchanged} = after;
  const {policy:p,revision:r,policyChanges:c,...original} = before; assert.deepEqual(unchanged,original);
  assert.deepEqual(await f.store.read('change'),unit); assert.deepEqual(await readFile(ledgerPath),bytes);
  assert.equal(policyRecoveries[0].proof.rejectedUserInputRef,'operational-relay');
  const replay = await f.run(); assert.equal(replay.code,0,JSON.stringify(replay)); assert.equal(replay.receipt.duplicate,true); assert.deepEqual(await f.goals.read('goal'),after);
  assert.equal((await f.run({...f.request,reason:'different'})).error,'POLICY_RECOVERY_CONFLICT');
});

test('AC-3 recovery rejects stale, unsupported, forged and unauthorized inputs without mutations',async t => {
  const cases = {
    'missing trusted verifier': f => {delete f.adapters.provider.verifyPolicyRefreshRecovery;},
    'operational relay': f => {f.ref='operational-relay';},
    'denied authority': f => f.deny(),
    'presence only': f => f.proof({originalAuthority:false}),
    'current policy actually authorized': f => f.proof({currentPolicyUnauthorized:false}),
    'prior unauthorized': f => f.proof({priorPolicyAuthorized:false}),
    'native account unverified': f => f.proof({nativeExecutionVerified:false}),
    'wrong proof binding': f => f.proof({ownerDigest:hash('forged')}),
    'wrong proof evidence': f => f.proof({evidenceDigest:hash('forged')}),
    'stale goal': f => {f.request.expectedRevision--;},
    'stale unit': f => {f.request.expectedUnitRevision++;},
    'forged goal': f => {f.request.goalDigest=hash('forged');},
    'forged unit': f => {f.request.unitDigest=hash('forged');},
    'wrong refresh': f => {f.request.changeDigest=hash('forged');},
    'wrong revision': f => {f.request.changeRevision--;},
    'arbitrary policy': f => {f.request.policy=f.badPolicy;},
    'changed source': f => writeFile(f.source.path,'changed'),
    'changed provenance': f => writeFile(f.request.provenance.path,'changed'),
    'changed target': f => f.targetChange(),
    'changed owner': f => f.ownerChange(),
    'source changes during proof': f => f.hook(()=>writeFile(f.source.path,'changed')),
    'target changes during proof': f => f.hook(()=>f.targetChange()),
    'owner changes during proof': f => f.hook(()=>f.ownerChange()),
    'review registered during proof': f => f.hook(()=>f.store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'goal'}})),
    'uncertain native effect': f => f.ledger.withLock('change',l=>l.append({event:'intent',seq:1,key:hash('effect'),effect:'session.start',args:{}})),
    'uncertain result': async f => f.ledger.withLock('change',async l=>{await l.append({event:'intent',seq:1,key:hash('effect'),effect:'session.start',args:{}});await l.append({event:'result',seq:1,key:hash('effect'),result:{status:'uncertain'}});}),
    'delivery begun': f => f.store.update('change',r=>({...r,deliveryPlan:{head:'head'}})),
    'registered reviewer': f => f.goals.transaction('goal',g=>({...g,revision:g.revision+1,reviews:[{unit:'review',targetUnit:'change'}]})),
    'wrong custody policy': f => f.goals.transaction('goal',g=>({...g,revision:g.revision+1,adoptions:[{...g.adoptions[0],policyDigest:hash('other')}]})),
  };
  for (const [name,mutate] of Object.entries(cases)) await t.test(name,async t => {
    const f = await fixture(t); await mutate(f);
    // Bind changed fixture state for guards that must independently reject otherwise fresh requests.
    if (['delivery begun','registered reviewer','wrong custody policy'].includes(name)) {
      const g=await f.goals.read('goal'),u=await f.store.read('change');f.request.goalDigest=digest(g);f.request.expectedRevision=g.revision;f.request.unitDigest=digest(u);f.request.expectedUnitRevision=u.revision;
    }
    const goal = await f.goals.read('goal'),unit = await f.store.read('change');
    const result = await f.run(f.request,f.ref); assert.notEqual(result.code,0,JSON.stringify(result));
    assert.deepEqual(await f.goals.read('goal'),goal); assert.deepEqual(await f.store.read('change'),unit);
  });
});

test('AC-3 policy recovery serializes duplicate attempts and rejects replay after later state changes',async t => {
  const f = await fixture(t);
  const outcomes = await Promise.all([f.run(),f.run()]); assert.ok(outcomes.every(r=>r.code===0),JSON.stringify(outcomes));
  assert.equal((await f.goals.read('goal')).policyRecoveries.length,1);
  await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,workHistory:[{evidence:'later'}]}));
  const before=await f.goals.read('goal'); assert.equal((await f.run()).error,'POLICY_RECOVERY_STALE'); assert.deepEqual(await f.goals.read('goal'),before);
});

test('AC-3 delayed public review registration and policy recovery serialize without a stale review ID',async t => {
  const {mkdir,open,stat} = await import('node:fs/promises');
  const f=await fixture(t),dir=path.join(f.stateRoot,'units','late-review');await mkdir(dir,{recursive:true});
  const lockPath=path.join(dir,'.lock'),lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();
  const before=(await stat(lockPath,{bigint:true})).atimeNs;
  const requestFile=path.join(f.cwd,'late-review.json');await writeFile(requestFile,JSON.stringify({kind:'review',targetUnit:'change',goalId:'goal',policyOverrides:{session:f.badPolicy},request:{text:'review',userInputRef:'original-review'}}));
  const registration=runUnitCli(['unit','start','late-review','--request',requestFile,'--project-root',f.cwd,'--non-interactive'],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters}).then(parse);
  // Observe the actual create-lock read rather than assuming registration has reached its blocking boundary.
  const deadline=Date.now()+5000;
  while((await stat(lockPath,{bigint:true})).atimeNs===before){assert.ok(Date.now()<deadline,'registration never reached create lock');await new Promise(r=>setTimeout(r,5));}
  const recovery=f.run();
  let timer;
  try { await Promise.race([recovery,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]); }
  finally {clearTimeout(timer);await lock.close();await rm(lockPath);}
  const [registered,recovered]=await Promise.all([registration,recovery]);
  assert.ok(registered.code!==0||recovered.code!==0,'registration and recovery both committed across the stale goal boundary');
  const goal=await f.goals.read('goal'),review=await f.store.read('late-review');
  if(review)assert.deepEqual(review.policy.session,goal.policy);
  if(recovered.code===0)assert.equal(review,null);
});

test('AC-3 recovery winning a registration race rejects the stale create and leaves its review ID reusable',async t => {
  const {stat}=await import('node:fs/promises');
  const f=await fixture(t),file=path.join(f.cwd,'racing-review.json');
  const request={kind:'review',targetUnit:'change',goalId:'goal',policyOverrides:{session:f.badPolicy},request:{text:'review',userInputRef:'original-review'}};
  await writeFile(file,JSON.stringify(request));
  let registration;
  f.hook(async()=>{
    registration=runUnitCli(['unit','start','racing-review','--request',file,'--project-root',f.cwd,'--non-interactive'],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters}).then(parse);
    const deadline=Date.now()+5000,lock=path.join(f.stateRoot,'units/racing-review/.ledger.lock');
    while(!await stat(lock).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error))){assert.ok(Date.now()<deadline,'registration did not reach its custody lock');await new Promise(r=>setTimeout(r,5));}
  });
  const recovered=await f.run();assert.equal(recovered.code,0,JSON.stringify(recovered));
  const stale=await registration;assert.equal(stale.error,'CONTINUITY_STALE',JSON.stringify(stale));assert.equal(await f.store.read('racing-review'),null);
  await writeFile(file,JSON.stringify({...request,policyOverrides:{session:{...f.policy,roles:{}}}}));
  const fresh=parse(await runUnitCli(['unit','start','racing-review','--request',file,'--project-root',f.cwd,'--non-interactive'],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:f.adapters}));
  assert.equal(fresh.code,0,JSON.stringify(fresh));
});
