import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function fixture(t,kind) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(),'authority-'))); t.after(() => rm(cwd,{recursive:true,force:true}));
  const stateRoot = path.join(cwd,'state'), store = createUnitStateStore(stateRoot), goals = createContinuityStore(stateRoot);
  const source = path.join(cwd,'goal.md'), provenance = path.join(cwd,'conversation.json');
  await writeFile(source,'Original approved work');
  const conversation = JSON.stringify([{actor:'human',id:'human-1',text:'Continue the approved work, including the documented repair.'},
    {actor:'operator',id:'operator-1',text:'Run adoption and goal amendment.'}]);
  await writeFile(provenance,conversation);
  const owner = {runtime:'cmux',sessionId:'native-session',incarnationId:'session-v1',cwd,
    worker:{executable:'/bin/codex',pid:42,incarnationId:'process-v1',threadId:'native-thread'}};
  const target = {head:'head',contentFingerprint:'content'};
  await store.create({schema:'harness.unit/1',unit:'change',kind:'impl',state:'InReview',policy:{goal:{class:'task'}},continuity:{goalId:'work'},
    stages:[],failures:[{signature:'original-failure'}],evidence:[{gate:'tests',status:'failed'}],accepted:null,scopePaths:['src']});
  await goals.create({goal:{id:'work',objective:'Approved work',criteria:['Verified repair'],remaining:['change'],status:'active'},
    policy:{runtime:'cmux',provider:'codex',account:'/example-account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest:hash('Original approved work')}});
  await goals.transaction('work',goal => ({...goal,revision:goal.revision+1,
    adoptions:[{id:'original-adoption',unit:'change',ownership:'existing',owner,userInputRef:'operator-1',requestDigest:effectArgsDigest('original-request')}],
    amendments:[{revision:2,previous:{objective:'Previous work',criteria:['Previous criteria']},reason:'Repair prerequisite',userInputRef:'operator-1'}]}));
  let calls = 0, hook = async () => {};
  const adapters = {git:{inspectUnit:async () => ({...target})},session:{observe:async () => structuredClone(owner)},provider:{
    verifyUserInput:async binding => ({...binding,verified:binding.userInputRef === 'human-1'}),
    async verifyAuthorityCorrection(input) {
      calls++;
      const messages = JSON.parse(await readFile(input.request.provenance.ref,'utf8'));
      const valid = hash(await readFile(input.request.provenance.ref)) === input.provenanceDigest
        && messages.find(item => item.id === input.userInputRef)?.actor === 'human'
        && messages.find(item => item.id === input.previousUserInputRef)?.actor === 'operator'
        && effectArgsDigest(input.record) === input.unitDigest && effectArgsDigest(input.goal) === input.goalDigest
        && effectArgsDigest(input.original) === input.originalDigest && effectArgsDigest(input.owner) === input.ownerDigest
        && effectArgsDigest(input.target) === input.targetDigest && input.kind === kind
        && (kind !== 'amendment' || input.result.objective === 'Approved work');
      await hook(input);
      return {...input,verified:valid};
    }}};
  const request = async extra => {
    const record = await store.read('change'), goal = await goals.read('work');
    return {id:'correction-1',unit:'change',expectedRevision:record.revision,expectedGoalRevision:goal.revision,
      unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),targetDigest:effectArgsDigest(target),
      original:{index:0,digest:effectArgsDigest(goal[kind === 'adoption' ? 'adoptions' : 'amendments'][0])},
      provenance:{ref:provenance,digest:hash(conversation)},reason:'Correct operator attribution using original human instruction',...extra};
  };
  const run = async (body,userInputRef = 'human-1',goalId = 'work') => {
    const file = path.join(cwd,'request.json'); await writeFile(file,JSON.stringify(body));
    const command = kind === 'adoption' ? ['unit','session-approval-correct','change'] : ['goal','approval-correct',goalId];
    const output = await runUnitCli([...command,'--request',file,'--user-input',userInputRef],{cwd,stateRoot,adapters});
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
  };
  const snapshot = async () => ({unit:await readFile(path.join(stateRoot,'units/change/unit.json'),'utf8'),
    goal:await readFile(path.join(stateRoot,'goals/work/goal.json'),'utf8'),ledger:await createLedgerStore(stateRoot).withLock('change',log => log.read())});
  return {cwd,stateRoot,store,goals,owner,target,source,provenance,adapters,request,run,snapshot,calls:() => calls,onVerify:callback => {hook=callback;}};
}

for (const kind of ['adoption','amendment']) {
  test(`AC-1 AC-2 public ${kind} correction preserves original receipts and unit bytes; exact replay revalidates without mutation`,async t => {
    const f = await fixture(t,kind), before = await f.snapshot(), request = await f.request(), goal = await f.goals.read('work');
    const result = await f.run(request); assert.equal(result.code,0,JSON.stringify(result));
    assert.deepEqual(result.receipt.original,goal[kind === 'adoption' ? 'adoptions' : 'amendments'][0]);
    const after = await f.goals.read('work'), {authorityCorrections,...rest} = after;
    assert.equal(authorityCorrections.length,1); assert.deepEqual({...rest,revision:goal.revision},goal);
    assert.equal((await f.snapshot()).unit,before.unit); assert.deepEqual((await f.snapshot()).ledger,before.ledger);
    const corrected = await f.snapshot(); assert.equal((await f.run(request)).receipt.duplicate,true);
    assert.equal(f.calls(),2); assert.deepEqual(await f.snapshot(),corrected);
    assert.notEqual((await f.run({...request,reason:'Changed payload'})).code,0); assert.deepEqual(await f.snapshot(),corrected);
    assert.notEqual((await f.run(await f.request({id:'second-correction'}))).code,0); assert.deepEqual(await f.snapshot(),corrected);
    f.owner.worker.pid++;
    assert.equal((await f.run(request)).error,'SESSION_OWNER_MISMATCH'); assert.deepEqual(await f.snapshot(),corrected);
  });

  test(`AC-2 ${kind} correction rejects forged authority, stale snapshots, sources, owners and uncertain effects atomically`,async t => {
    for (const mode of ['operator','same-authority','missing-provider','unverified-context','forged-source','non-file-provenance','wrong-receipt','unit-revision','goal-revision','unit-digest',
      'goal-digest','target','owner','source','source-during-verify','target-during-verify','owner-during-verify','binding-mismatch','uncertain','delivered','inactive-goal','wrong-unit','wrong-goal','extra-key','bad-id'].filter(mode => kind === 'amendment' || mode !== 'wrong-goal')) {
      await t.test(mode,async t => {
        const f = await fixture(t,kind); let request = await f.request(), user = 'human-1';
        if (mode === 'operator') user = 'another-operator';
        if (mode === 'same-authority') user = 'operator-1';
        if (mode === 'missing-provider') delete f.adapters.provider.verifyAuthorityCorrection;
        if (mode === 'unverified-context') f.adapters.provider.verifyAuthorityCorrection = async input => ({...input,verified:false});
        if (mode === 'forged-source') request.provenance.digest = hash('fabricated');
        if (mode === 'non-file-provenance') request.provenance.ref = 'conversation:human-1';
        if (mode === 'wrong-receipt') request.original.digest = hash('fabricated');
        if (mode === 'unit-revision') request.expectedRevision++;
        if (mode === 'goal-revision') request.expectedGoalRevision++;
        if (mode === 'unit-digest') request.unitDigest = hash('fabricated');
        if (mode === 'goal-digest') request.goalDigest = hash('fabricated');
        if (mode === 'target') f.target.head = 'changed';
        if (mode === 'owner') f.owner.worker.pid++;
        if (mode === 'source') await writeFile(f.source,'changed');
        if (mode === 'source-during-verify') f.onVerify(() => writeFile(f.source,'changed'));
        if (mode === 'target-during-verify') f.onVerify(async () => {f.target.contentFingerprint='changed';});
        if (mode === 'owner-during-verify') f.onVerify(async () => {f.owner.worker.pid++;});
        if (mode === 'binding-mismatch') f.adapters.provider.verifyAuthorityCorrection = async input => ({...input,ownerDigest:hash('foreign'),verified:true});
        if (mode === 'uncertain') await createLedgerStore(f.stateRoot).withLock('change',async log => {
          await log.append({event:'intent',seq:1,key:'effect-1',effect:'session.start',args:{}});
          await log.append({event:'result',seq:1,key:'effect-1',result:{status:'uncertain'}});
        });
        if (mode === 'delivered') {await f.store.update('change',record => ({...record,deliveryResult:{delivered:true}})); request = await f.request();}
        if (mode === 'inactive-goal') {await f.goals.transaction('work',goal => ({...goal,revision:goal.revision+1,goal:{...goal.goal,remaining:['other','change']}})); request = await f.request();}
        if (mode === 'wrong-unit') request.unit = 'foreign';
        if (mode === 'extra-key') request.approved = true;
        if (mode === 'bad-id') request.id = '../escape';
        const before = await f.snapshot(), result = await f.run(request,user,mode === 'wrong-goal' ? 'foreign' : 'work');
        assert.notEqual(result.code,0,JSON.stringify(result)); assert.deepEqual(await f.snapshot(),before);
      });
    }
  });

  test(`AC-2 ${kind} correction holds ledger, unit and goal locks during source verification`,async t => {
    const f = await fixture(t,kind), request = await f.request();
    let unitRead, concurrent, readFinished = false, correctionFinished = false;
    f.onVerify(async () => {
      f.onVerify(async () => {});
      unitRead = f.store.withLock('change',async () => {readFinished=true;});
      concurrent = f.run(request).then(result => {correctionFinished=true; return result;});
      await assert.rejects(f.goals.transaction('work',goal => goal),{code:'GOAL_LOCKED'});
      assert.equal(readFinished,false); assert.equal(correctionFinished,false);
    });
    const result = await f.run(request); assert.equal(result.code,0,JSON.stringify(result));
    await unitRead; assert.equal((await concurrent).receipt.duplicate,true);
    assert.equal((await f.goals.read('work')).authorityCorrections.length,1);
  });
}

test('AC-2 a superseded adoption cannot regain authority through provenance correction',async t => {
  const f = await fixture(t,'adoption');
  await f.goals.transaction('work',goal => ({...goal,revision:goal.revision+1,rebindings:[{unit:'change',owner:{...f.owner,worker:{...f.owner.worker,pid:43}}}]}));
  const before = await f.snapshot(); assert.equal((await f.run(await f.request())).error,'AUTHORITY_CORRECTION_CONFLICT');
  assert.deepEqual(await f.snapshot(),before);
});

test('AC-1 an earlier goal amendment is verified against its actual resulting definition',async t => {
  const f = await fixture(t,'amendment');
  await f.goals.transaction('work',goal => ({...goal,revision:goal.revision+1,goal:{...goal.goal,objective:'Later work'},
    amendments:[...goal.amendments,{revision:3,previous:{objective:'Approved work',criteria:['Verified repair']},userInputRef:'another-human',reason:'Later change'}]}));
  assert.equal((await f.run(await f.request())).code,0);
  assert.equal((await f.goals.read('work')).authorityCorrections[0].result.objective,'Approved work');
});

async function completeFixture(f) {
  const proof = [{criterion:'Verified repair',unit:'change',acceptance:'AC-1'}];
  const resultPath = path.join(f.cwd,'result.md'), closurePath = path.join(f.cwd,'native-completion.json');
  await writeFile(resultPath,'Verified source result');
  const accepted = {...f.target,basis:'review',verdictBy:'session'};
  const closure = {owner:structuredClone(f.owner),accepted,closed:true};
  await writeFile(closurePath,JSON.stringify(closure));
  const completionProof = {ref:closurePath,digest:hash(await readFile(closurePath))};
  await f.store.update('change',record=>({...record,state:'Closed',head:accepted.head,contentFingerprint:accepted.contentFingerprint,accepted,
    goalCompletion:{goalId:'work',proof},resultRef:{path:resultPath,digest:hash('Verified source result')},deliveryResult:{level:'none'}}));
  await f.goals.transaction('work',goal=>({...goal,revision:goal.revision+1,goal:{...goal.goal,status:'complete',remaining:[]},completion:{unit:'change',proof}}));
  // Completed owners and their original Git checkout may no longer exist.
  delete f.adapters.session; delete f.adapters.git;
  let observations = 0;
  f.adapters.provider.verifyCompletedAuthorityTarget = async input => {
    observations++;
    const bytes = await readFile(input.completionProof.ref), historical = JSON.parse(bytes);
    return {...input,verified:hash(bytes) === input.completionProof.digest && historical.closed === true
      && effectArgsDigest(historical.owner) === input.ownerDigest && effectArgsDigest(historical.accepted) === input.targetDigest
      && input.mode === 'completed' && input.completionDigest === effectArgsDigest({completion:input.goal.completion,
        goalCompletion:input.record.goalCompletion,resultRef:input.record.resultRef,completionProof:input.completionProof,ledger:input.ledger})};
  };
  return {accepted,closurePath,completionProof,observations:()=>observations,
    request:async extra=>f.request({targetDigest:effectArgsDigest(accepted),completionProof,...extra})};
}

for (const kind of ['adoption','amendment']) {
  test(`AC-1 AC-2 completed ${kind} audit uses historical target and native proof, preserves completion and exact replay`,async t=>{
    const f=await fixture(t,kind), historical=await completeFixture(f), request=await historical.request(), before=await f.snapshot();
    const result=await f.run(request); assert.equal(result.code,0,JSON.stringify(result));
    assert.equal(result.receipt.mode,'completed'); assert.ok(result.receipt.completionDigest);
    const after=await f.snapshot(), goal=JSON.parse(after.goal), original=JSON.parse(before.goal);
    const {authorityCorrections,...rest}=goal; assert.deepEqual({...rest,revision:original.revision},original);
    assert.equal(authorityCorrections.length,1); assert.equal(after.unit,before.unit); assert.deepEqual(after.ledger,before.ledger);
    assert.equal((await f.run(request)).receipt.duplicate,true); assert.deepEqual(await f.snapshot(),after);
    assert.equal(historical.observations(),4); assert.equal(f.calls(),2);
    await writeFile(historical.closurePath,'Changed historical proof');
    assert.equal((await f.run(request)).error,'AUTHORITY_CORRECTION_STALE'); assert.deepEqual(await f.snapshot(),after);
  });

  test(`AC-2 completed ${kind} rejects missing, forged, stale and pending historical proofs without execution rights`,async t=>{
    for (const mode of ['missing-proof','unverified-proof','wrong-binding','missing-verifier','wrong-target','source-drift','result-drift',
      'proof-during-verification','unverified-human','active-goal','wrong-completion','wrong-unit-proof','unit-drift','superseded-custody','pending','running','uncertain']) {
      await t.test(mode,async t=>{
        const f=await fixture(t,kind), historical=await completeFixture(f); let request=await historical.request(), user='human-1';
        if(mode==='missing-proof')delete request.completionProof;
        if(mode==='missing-verifier')delete f.adapters.provider.verifyCompletedAuthorityTarget;
        if(mode==='unverified-proof')f.adapters.provider.verifyCompletedAuthorityTarget=async input=>({...input,verified:false});
        if(mode==='wrong-binding')f.adapters.provider.verifyCompletedAuthorityTarget=async input=>({...input,ownerDigest:hash('foreign'),verified:true});
        if(mode==='wrong-target')request.targetDigest=hash('changed');
        if(mode==='source-drift')await writeFile(f.source,'changed');
        if(mode==='result-drift')await writeFile(path.join(f.cwd,'result.md'),'changed');
        if(mode==='proof-during-verification')f.onVerify(()=>writeFile(historical.closurePath,'changed'));
        if(mode==='unverified-human')user='operator-1';
        if(mode==='active-goal')await f.goals.transaction('work',goal=>({...goal,revision:goal.revision+1,goal:{...goal.goal,status:'active',remaining:['change']}}));
        if(mode==='wrong-completion')await f.goals.transaction('work',goal=>({...goal,revision:goal.revision+1,completion:{...goal.completion,unit:'foreign'}}));
        if(mode==='wrong-unit-proof')await f.store.update('change',record=>({...record,goalCompletion:{...record.goalCompletion,proof:[]}}));
        if(mode==='unit-drift')await f.store.update('change',record=>({...record,result:'changed'}));
        if(mode==='superseded-custody')await f.goals.transaction('work',goal=>({...goal,revision:goal.revision+1,rebindings:[{unit:'change',owner:{...f.owner,worker:{...f.owner.worker,pid:43}}}]}));
        if(['pending','running','uncertain'].includes(mode))await createLedgerStore(f.stateRoot).withLock('change',async log=>{
          await log.append({event:'intent',seq:1,key:'pending',effect:'session.close',args:{}});
          await log.append({event:'result',seq:1,key:'pending',result:{status:mode}});
        });
        if(['active-goal','wrong-completion','wrong-unit-proof','superseded-custody'].includes(mode))request=await historical.request();
        const before=await f.snapshot();assert.notEqual((await f.run(request,user)).code,0);assert.deepEqual(await f.snapshot(),before);
      });
    }
  });
}

for (const kind of ['adoption','amendment']) {
  for (const completed of [false,true]) {
    test(`AC-2 ${completed ? 'completed' : 'live'} ${kind} fences original conversation bytes during verification and replay`,async t=>{
      for (const replay of [false,true]) {
        await t.test(replay ? 'exact replay' : 'first append',async t=>{
          const f=await fixture(t,kind), historical=completed ? await completeFixture(f) : null;
          const request=await (historical ? historical.request() : f.request());
          if(replay)assert.equal((await f.run(request)).code,0);
          const before=await f.snapshot();
          f.onVerify(()=>writeFile(f.provenance,'changed after contextual verification read the original conversation'));
          const result=await f.run(request);
          assert.equal(result.error,'AUTHORITY_CORRECTION_STALE',JSON.stringify(result));
          assert.deepEqual(await f.snapshot(),before);
          assert.equal((await f.run(request)).error,'AUTHORITY_CORRECTION_STALE');
          assert.deepEqual(await f.snapshot(),before);
        });
      }
    });
  }
}

for (const kind of ['adoption','amendment']) {
  for (const completed of [false,true]) {
    test(`AC-2 ${completed ? 'completed' : 'live'} ${kind} rejects external source writes during the final asynchronous observation`,async t=>{
      for (const replay of [false,true]) {
        await t.test(replay ? 'exact replay' : 'first append',async t=>{
          const f=await fixture(t,kind), historical=completed ? await completeFixture(f) : null;
          const request=await (historical ? historical.request() : f.request());
          if(replay)assert.equal((await f.run(request)).code,0);
          const before=await f.snapshot(); let count=0,signal,release;
          const waiting=new Promise(resolve=>{signal=resolve;}),unblock=new Promise(resolve=>{release=resolve;});
          const holder=completed ? f.adapters.provider : f.adapters.session;
          const method=completed ? 'verifyCompletedAuthorityTarget' : 'observe',observe=holder[method];
          holder[method]=async (...args)=>{
            const result=await observe(...args);
            if(++count===2){signal();await unblock;}
            return result;
          };
          const running=f.run(request); await waiting;
          try { await writeFile(f.provenance,'external writer changed the conversation while the final observer waited'); }
          finally { release(); }
          const result=await running;
          assert.equal(result.error,'AUTHORITY_CORRECTION_STALE',JSON.stringify(result));
          assert.deepEqual(await f.snapshot(),before);
        });
      }
    });
  }
}

for (const kind of ['adoption','amendment']) {
  test(`AC-2 live ${kind} rejects external target writes during the final native observation`,async t=>{
    for (const replay of [false,true]) {
      await t.test(replay ? 'exact replay' : 'first append',async t=>{
        const f=await fixture(t,kind),targetFile=path.join(f.cwd,'git-target.json');
        await writeFile(targetFile,JSON.stringify(f.target));
        f.adapters.git.inspectUnit=async()=>JSON.parse(await readFile(targetFile,'utf8'));
        const request=await f.request(); if(replay)assert.equal((await f.run(request)).code,0);
        const before=await f.snapshot(); let count=0,signal,release;
        const waiting=new Promise(resolve=>{signal=resolve;}),unblock=new Promise(resolve=>{release=resolve;});
        const observe=f.adapters.session.observe;
        f.adapters.session.observe=async(...args)=>{
          const result=await observe(...args);
          if(++count===2){signal();await unblock;}
          return result;
        };
        const running=f.run(request); await waiting;
        try { await writeFile(targetFile,JSON.stringify({...f.target,contentFingerprint:'changed-by-external-writer'})); }
        finally { release(); }
        const result=await running;
        assert.equal(result.error,'AUTHORITY_CORRECTION_STALE',JSON.stringify(result));
        assert.deepEqual(await f.snapshot(),before);
      });
    }
  });
}
