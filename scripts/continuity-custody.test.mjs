import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { taskDigest } from './lib/session-task.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const parse = value => JSON.parse(value.slice(value.lastIndexOf('RESULT ')+7));
const packet = ['목표: goal','수용 기준: done','작업관리: change','결정: approved','변경: source','검증: checks','남은 일·위험: review','다음 단위 첫 행동: inspect'].join('\n');
const fields = {title:'Completed change',objective:'goal',acceptance:'done',tracking:'none',decision:'approved',changed:'source',verification:'checks',remainingRisk:'none',nextFirstAction:'resume'};
async function fixture(t,state = 'InReview') {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(),'custody-'))); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateRoot = path.join(cwd,'state'), store = createUnitStateStore(stateRoot), goals = createContinuityStore(stateRoot);
  const source = path.join(cwd,'goal.md'); await writeFile(source,'goal');
  const execution = {runtime:'cmux',provider:'codex',account:'/personal-account',model:'model',effort:'high',argv:['codex']};
  await goals.create({goal:{id:'goal',objective:'goal',criteria:['done'],remaining:['change'],status:'active'},policy:execution,source:{path:source,digest:hash('goal')}});
  const owner = {runtime:'cmux',sessionId:'user-session',incarnationId:'user-v1',cwd,
    worker:{executable:'/bin/codex',pid:42,incarnationId:'worker-v1',threadId:'native-user'}};
  const reviewer = {...owner,sessionId:'review-session',incarnationId:'review-v1',closable:true,
    worker:{...owner.worker,pid:43,threadId:'native-review',incarnationId:'review-worker-v1'}};
  const target = {head:'head-1',contentFingerprint:'content-1'};
  await store.create({schema:'harness.unit/1',unit:'change',kind:'chore',state,continuity:{goalId:'goal'},continuityRequired:true,
    request:{text:'approved change',userInputRef:'original-request'},canon:[],head:target.head,contentFingerprint:target.contentFingerprint,
    policy:{goal:{class:'task'},delivery:'none',review:{mode:'required',by:'session',triggers:[]},retry:{maxPerSignature:2,maxResolver:2},session:{...execution,account:'/historical-account'}},
    accepted:state === 'Accepted' ? {...target,basis:'review',verdictBy:'session'} : null,
    acceptance:[{id:'AC-1',text:'done',status:'covered'},{id:'AC-4',text:'removed',status:'dropped'}],
    acceptanceAmendments:[{request:{id:'drop-4'},before:{id:'AC-4',text:'removed'}}],
    acceptanceCorrections:state === 'InReview' ? [{request:{id:'correct-1',acceptanceRef:'AC-5'},previousReview:{verdict:'fix'}}] : [],failures:[{signature:'prior-failure',digest:'retained'}],evidence:[1,2,3,4,5].map(i=>({gate:`gate-${i}`,exit:0,status:'passing',covers:['AC-1']})),
    findings:[],scopePaths:['source.mjs'],changedPaths:['source.mjs'],assumptions:[],openDecisions:[],tracker:null,diff:null,handoff:null,
    stages:[{name:'implement',attempt:1,submittedAt:'earlier',checkpoint:'baseline',checkpointHead:target.head}],
    reviewDecision:{required:true,by:'session',head:target.head,contentFingerprint:target.contentFingerprint},verdict:null});
  // A historical submitted record is fixture input, not a product-state migration.
  const unitFile = path.join(stateRoot,'units/change/unit.json');
  await writeFile(unitFile,JSON.stringify({...await store.read('change'),revision:36}));
  let live = owner, authorized = true, hook = async()=>{}, launches = 0;
  const effects = [], receipts = new Map();
  const authority = path.join(cwd,'authority.json'), permission = JSON.stringify({operation:'adopt',unit:'change',goalId:'goal',owner,policy:execution});
  await writeFile(authority,permission);
  const adapters = {...createAdapters({repositoryRoot:cwd}),git:{inspectUnit:async()=>({...target})},
    checkpoint:{createCheckpoint:async ({ref})=>({commit:ref,head:target.head,worktreeChanged:false,indexChanged:false,excluded:[]}),
      inspectChanges:async()=>({head:target.head,firstCheckpointDiff:[],attemptDiff:[],patch:'verified source change'})},
    provider:{verifyUserInput:async input=>({...input,verified:authorized && input.effect === 'unit.session.adopt' && input.userInputRef === 'native-user-message'}),
      async verifySessionAdoption(input) {
        const {request,record,goal,target:observed,...binding} = input;
        const verified = request.provenance.ref === authority && hash(await readFile(authority)) === request.provenance.digest
          && (await readFile(authority,'utf8')) === permission && input.ownerDigest === effectArgsDigest(owner)
          && input.unitDigest === effectArgsDigest(record) && input.targetDigest === effectArgsDigest(observed)
          && input.policyDigest === effectArgsDigest(goal.policy) && goal.policy.account === '/personal-account';
        await hook(); return {...binding,verified};
      }},
    session:{observe:async input=>input.recipient ? {...owner,executable:owner.worker.executable} : live,
      async execute(input) {
        effects.push(input.effect);
        if(input.effect === 'session.start') {
          launches++; const result = {...reviewer,task:{schema:'harness.goal-receipt/1',sessionId:reviewer.sessionId,incarnationId:reviewer.incarnationId,cwd,
            effectKey:input.key,promptDigest:taskDigest('review'),goalDigest:input.args.goalDigest,goal:{threadId:'native-review',status:'active',objective:'review'},
            threadId:'native-review',turnId:'turn',activityId:'read',packets:['handoff','goal','result'].filter(name=>input.args[`${name}Path`]).map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}};
          receipts.set(input.key,result); return result;
        }
        if(input.effect === 'session.close') { assert.equal(input.args.owner.sessionId,reviewer.sessionId); return {closed:true,sessionId:reviewer.sessionId,incarnationId:reviewer.incarnationId}; }
        const recipient = input.args.recipient;
        const result = {...recipient,task:{schema:'harness.task-receipt/1',effectKey:input.key,sessionId:recipient.sessionId,incarnationId:recipient.incarnationId,cwd:recipient.cwd,
          promptDigest:taskDigest('result'),threadId:recipient.worker?.threadId ?? 'recipient-thread',requestId:'request',turnId:'turn',activityId:'read',
          packets:[{path:input.args.resultPath,digest:input.args.resultDigest}]}};
        receipts.set(input.key,result); return result;
      },verify:async input=>receipts.has(input.key) ? {status:'completed',result:receipts.get(input.key)}
        : input.effect === 'session.close' ? {status:'completed',result:{closed:true,sessionId:reviewer.sessionId,incarnationId:reviewer.incarnationId}} : {status:'unknown'}}};
  const run = async args=>parse(await runUnitCli(['unit',...args],{cwd,stateRoot,adapters}));
  const request = async extra=>({id:'adopt-1',expectedRevision:(await store.read('change')).revision,expectedGoalRevision:(await goals.read('goal')).revision,
    unitDigest:effectArgsDigest(await store.read('change')),goalDigest:effectArgsDigest(await goals.read('goal')),targetDigest:effectArgsDigest(target),owner,
    provenance:{ref:authority,digest:hash(permission)},reason:'User authorized this exact existing native owner',...extra});
  const adopt = async body=>{const file = path.join(cwd,`${body.id}.json`);await writeFile(file,JSON.stringify(body));return run(['session-adopt','change','--request',file,'--user-input','native-user-message']);};
  const startReview = async()=>{
    const file=path.join(cwd,'review-unit.json');await writeFile(file,JSON.stringify({kind:'review',targetUnit:'change',goalId:'goal',policyOverrides:{session:execution},request:{text:'Independent review',userInputRef:'review-permission'}}));
    const started=await run(['start','review','--request',file,'--non-interactive']);assert.equal(started.code,0,JSON.stringify(started));
    const handoffPath=path.join(cwd,'handoff.md');await writeFile(handoffPath,packet);
    const launch=path.join(cwd,'launch.json');await writeFile(launch,JSON.stringify({cwd,handoffPath,handoffDigest:hash(packet),parentRuntime:owner,waitSeconds:0}));
    return run(['session-start','review','--request',launch]);
  };
  return {cwd,stateRoot,store,goals,source,owner,reviewer,target,adapters,unitFile,run,request,adopt,startReview,effects,
    setLive:value=>{live=value;},deny:()=>{authorized=false;},onVerify:value=>{hook=value;},launches:()=>launches};
}

test('public existing-owner adoption preserves InReview revision 36 and complete history byte-for-byte, then launches and submits distinct review',async t=>{
  const f=await fixture(t), before=await readFile(f.unitFile), request=await f.request();
  assert.equal((await f.adopt(request)).code,0);assert.deepEqual(await readFile(f.unitFile),before);
  assert.equal((await f.adopt(request)).receipt.duplicate,true);assert.equal((await f.goals.read('goal')).adoptions.length,1);
  assert.equal((await f.adopt({...request,reason:'different'})).error,'CUSTODY_CONFLICT');
  const goal=await f.goals.read('goal');assert.equal(goal.bootstraps,undefined);assert.equal(goal.transfers,undefined);
  assert.equal((await f.startReview()).code,0);assert.equal(f.launches(),1);assert.deepEqual(await readFile(f.unitFile),before);
  const opened=await f.run(['stage','open','review','review']);assert.equal(opened.code,0,JSON.stringify(opened));
  const input=JSON.parse(await readFile(opened.input));assert.equal(input.data.acceptance[1].status,'dropped');assert.equal(input.data.handoff.evidence.length,5);
  const output=path.join(f.cwd,'verdict.json');await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'independent-verdict',status:'done',summary:'Verified original change and retained history',findings:[],verdict:'ship',reviewedHead:input.head}));
  assert.equal((await f.run(['stage','submit','review','review','--output',output])).error,'SESSION_OWNER_MISMATCH');
  f.setLive(f.reviewer);assert.equal((await f.run(['stage','submit','review','review','--output',output])).code,0);
  assert.equal((await f.store.read('change')).verdict,'ship');assert.equal((await f.store.read('review')).state,'Closed');
  const returning=path.join(f.cwd,'return.json');await writeFile(returning,JSON.stringify({parentRuntime:f.reviewer,returnTo:{...f.owner,executable:'/bin/codex'},handoffContent:packet,resultFields:fields}));
  const returned=await f.run(['session-return','review','--request',returning]);assert.equal(returned.code,3,JSON.stringify(returned));
  const finalized=await f.run(['finalize','review']);assert.equal(finalized.code,0,JSON.stringify(finalized));
  assert.equal(f.effects.filter(effect=>effect==='session.close').length,1);
  assert.deepEqual((await f.store.read('change')).failures,JSON.parse(before).failures);
});

test('SelfGated and Accepted existing owners are adopted without rewriting their units; recipient-free goal completion retains the user session even if runtime marks it closable',async t=>{
  for(const state of ['SelfGated','Accepted']) await t.test(state,async t=>{
    const f=await fixture(t,state), before=await readFile(f.unitFile);assert.equal((await f.adopt(await f.request())).code,0);assert.deepEqual(await readFile(f.unitFile),before);
    if(state==='Accepted') {
      f.setLive({...f.owner,closable:true});const file=path.join(f.cwd,'finish.json');await writeFile(file,JSON.stringify({parentRuntime:f.owner,goalComplete:true,goalProof:[{criterion:'done',unit:'change',acceptance:'AC-1'}],resultFields:fields}));
      const result=await f.run(['finish','change','--request',file]);assert.equal(result.code,0,JSON.stringify(result));
      assert.equal((await f.goals.read('goal')).goal.status,'complete');assert.equal((await f.store.read('change')).state,'Closed');assert.deepEqual(f.effects,[]);
    }
  });
});

test('authorization, revision, target, source, policy and identity failures leave the original unit and goal untouched',async t=>{
  for(const mode of ['revision','goal-revision','unit-digest','goal-digest','target','source','policy','runtime','native','cwd','provenance','permission','missing-verifier','target-race','native-race']) await t.test(mode,async t=>{
    const f=await fixture(t), request=await f.request();
    if(mode==='revision')request.expectedRevision++;
    if(mode==='goal-revision')request.expectedGoalRevision++;
    if(mode==='unit-digest')request.unitDigest=hash('other');
    if(mode==='goal-digest')request.goalDigest=hash('other');
    if(mode==='target')f.target.head='other';
    if(mode==='source')await writeFile(f.source,'changed');
    if(mode==='policy')await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,policy:{...g.policy,account:'/other-account'}}));
    if(mode==='runtime')request.owner={...f.owner,runtime:'orca'};
    if(mode==='native')f.setLive({...f.owner,worker:{...f.owner.worker,threadId:'other'}});
    if(mode==='cwd')request.owner={...f.owner,cwd:path.dirname(f.cwd)};
    if(mode==='provenance')request.provenance.digest=hash('forged');
    if(mode==='permission')f.deny();
    if(mode==='missing-verifier')delete f.adapters.provider.verifySessionAdoption;
    if(mode==='target-race')f.onVerify(()=>{f.target.head='other';});
    if(mode==='native-race')f.onVerify(()=>{f.setLive({...f.owner,worker:{...f.owner.worker,pid:99}});});
    const before=await readFile(f.unitFile), goal=await f.goals.read('goal');const result=await f.adopt(request);
    assert.notEqual(result.code,0,JSON.stringify(result));assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);assert.equal(f.launches(),0);
  });
});

test('existing managed custody, uncertain effects and competing adoptions cannot replace an owner',async t=>{
  const f=await fixture(t);await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,bootstraps:[{unit:'change',sessionId:'other-live-owner'}]}));
  assert.equal((await f.adopt(await f.request())).error,'CUSTODY_CONFLICT');
  const g=await fixture(t);await createLedgerStore(g.stateRoot).withLock('change',l=>l.append({event:'intent',seq:1,key:'unknown',effect:'session.start'}));
  assert.equal((await g.adopt(await g.request())).error,'EFFECT_UNCERTAIN');
  const h=await fixture(t), request=await h.request();
  const results=await Promise.all([h.adopt(request),h.adopt({...request,id:'second'})]);assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);assert.equal((await h.goals.read('goal')).adoptions.length,1);
  h.setLive({...h.owner,incarnationId:'replaced'});assert.equal((await h.adopt((await h.goals.read('goal')).adoptions[0].request)).error,'SESSION_OWNER_MISMATCH');
});

test('review launch reobserves the adopted native owner at the actual effect boundary and does not launch after drift',async t=>{
  const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);
  let observations=0;f.adapters.session.observe=async()=>++observations===1 ? f.owner : {...f.owner,worker:{...f.owner.worker,threadId:'replacement'}};
  const result=await f.startReview();assert.notEqual(result.code,0);assert.equal(f.launches(),0);
});

test('review launch rejects live Git drift and holds target/goal custody through effect receipt and registration',async t=>{
  const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);f.target.head='external-head';
  assert.notEqual((await f.startReview()).code,0);assert.equal(f.launches(),0);
  const g=await fixture(t);assert.equal((await g.adopt(await g.request())).code,0);
  const execute=g.adapters.session.execute;let locked=false;
  g.adapters.session.execute=async input=>{
    await assert.rejects(g.goals.transaction('goal',goal=>({...goal,revision:goal.revision+1})),{code:'GOAL_LOCKED'});
    locked=true;return execute(input);
  };
  assert.equal((await g.startReview()).code,0);assert.equal(locked,true);assert.equal((await g.goals.read('goal')).reviews.length,1);
});

test('crash after durable native result but before goal registration reuses the original snapshot and never launches twice',async t=>{
  const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);
  const before=await f.goals.read('goal');assert.equal((await f.startReview()).code,0);
  // Seed the crash image: the effect ledger is durable and goal registration did not commit.
  await writeFile(path.join(f.stateRoot,'goals/goal/goal.json'),JSON.stringify({...before,revision:before.revision+2}));
  const result=await f.startReview();assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.launches(),1);assert.equal((await f.goals.read('goal')).reviews.length,1);
});

test('adopted return finalization delivers the result and retains the user owner; terminal drift cannot report success',async t=>{
  for(const drift of [false,true]) await t.test(String(drift),async t=>{
    const f=await fixture(t,'Accepted');assert.equal((await f.adopt(await f.request())).code,0);
    const recipient={sessionId:'supervisor',incarnationId:'supervisor-v1',cwd:f.cwd,executable:'/bin/codex'};
    const observe=f.adapters.session.observe;f.adapters.session.observe=input=>input.recipient?.sessionId==='supervisor' ? recipient : observe(input);
    const file=path.join(f.cwd,'finish-return.json');await writeFile(file,JSON.stringify({parentRuntime:f.owner,returnTo:recipient,goalComplete:true,
      goalProof:[{criterion:'done',unit:'change',acceptance:'AC-1'}],resultFields:fields}));
    assert.equal((await f.run(['finish','change','--request',file])).code,3);
    if(drift){let checks=0;f.adapters.git.inspectUnit=async()=>{if(++checks===3)f.target.head='changed';return {...f.target};};}
    const result=await f.run(['finalize','change']);assert.equal(result.code,drift ? 3 : 0,JSON.stringify(result));
    assert.equal((await f.store.read('change')).state,drift ? 'SelfGated' : 'Closed');assert.ok(!f.effects.includes('session.close'));
  });
});

test('same-session continuation propagates existing ownership without launch or close authority',async t=>{
  const f=await fixture(t,'Accepted');await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['change','next']}}));
  assert.equal((await f.adopt(await f.request())).code,0);const file=path.join(f.cwd,'continue.json');
  await writeFile(file,JSON.stringify({parentRuntime:f.owner,sameSession:{approved:true,nextUnit:'next'},resultFields:fields}));
  const result=await f.run(['finish','change','--request',file]);assert.equal(result.code,0,JSON.stringify(result));
  const goal=await f.goals.read('goal');assert.equal(goal.adoptions.at(-1).ownership,'existing');assert.deepEqual(goal.adoptions.at(-1).owner,f.owner);assert.equal(goal.bootstraps,undefined);assert.deepEqual(f.effects,[]);
});

test('delivery reobserves adopted native custody before each repository mutation',async t=>{
  const f=await fixture(t,'Accepted');Object.assign(f.target,{repo:'example/product',branch:'fix/change',base:'main',tree:'tree-1',indexTree:'tree-1',headTree:'tree-0'});
  await f.store.update('change',r=>({...r,accepted:{...f.target,basis:'review',verdictBy:'session'},policy:{...r.policy,delivery:'push'}}));
  assert.equal((await f.adopt(await f.request())).code,0);const mutations=[];
  Object.assign(f.adapters.git,{
    deliveryContext:async()=>({resourceOwned:true,productOwned:true,inScope:true,operational:false,irreversible:false,containsSecret:false,forbiddenCommand:false,explicitUserInstruction:true}),
    execute:async input=>{mutations.push(input.effect);assert.equal(input.effect,'git.commit');const result={sha:'commit-2',parent:f.target.head,tree:f.target.tree,contentFingerprint:f.target.contentFingerprint};
      Object.assign(f.target,{head:result.sha,headParent:result.parent,headTree:result.tree});f.setLive({...f.owner,worker:{...f.owner.worker,threadId:'replacement'}});return result;},
    verify:async()=>({status:'unknown',verify:{adapter:'repository',operation:'inspect',args:{}}})});
  const file=path.join(f.cwd,'push.json');await writeFile(file,JSON.stringify({parentRuntime:f.owner,goalComplete:true,requestedDelivery:'push',
    goalProof:[{criterion:'done',unit:'change',acceptance:'AC-1'}],resultFields:fields}));
  assert.notEqual((await f.run(['finish','change','--request',file])).code,0);assert.deepEqual(mutations,['git.commit']);
});

test('a changed target or goal definition cannot reuse an already launched reviewer',async t=>{
  for(const change of ['target','goal']) await t.test(change,async t=>{
    const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);assert.equal((await f.startReview()).code,0);
    if(change==='target'){f.target.contentFingerprint='new-content';await f.store.update('change',r=>({...r,contentFingerprint:'new-content'}));}
    else await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,objective:'different-goal'}}));
    assert.notEqual((await f.startReview()).code,0);assert.equal(f.launches(),1);
  });
});

test('adopted owner transfers to a verified new worker and finalizes without closing the existing session',async t=>{
  const f=await fixture(t,'Accepted');await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['change','next']}}));
  assert.equal((await f.adopt(await f.request())).code,0);const file=path.join(f.cwd,'transfer.json');
  await writeFile(file,JSON.stringify({parentRuntime:f.owner,successor:{approved:true,unit:'next',cwd:f.cwd},handoffContent:packet,resultFields:fields}));
  const started=await f.run(['finish','change','--request',file]);assert.equal(started.code,3,JSON.stringify(started));
  const finalized=await f.run(['finalize','change']);assert.equal(finalized.code,0,JSON.stringify(finalized));
  assert.equal((await f.store.read('change')).state,'Closed');assert.deepEqual((await f.goals.read('goal')).goal.remaining,['next']);assert.ok(!f.effects.includes('session.close'));
});

test('native reviewer thread and target authority are rechecked under the final verdict lock',async t=>{
  for(const drift of ['thread','policy']) await t.test(drift,async t=>{
    const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);assert.equal((await f.startReview()).code,0);
    const opened=await f.run(['stage','open','review','review']);assert.equal(opened.code,0);
    const input=JSON.parse(await readFile(opened.input)),output=path.join(f.cwd,'review-output.json');
    await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'review-verdict',status:'done',summary:'Review source',findings:[],verdict:'ship',reviewedHead:input.head}));
    f.setLive(f.reviewer);const inspect=f.adapters.checkpoint.inspectChanges;
    f.adapters.checkpoint.inspectChanges=async(...args)=>{
      if(drift==='thread')f.setLive({...f.reviewer,worker:{...f.reviewer.worker,threadId:'reused-thread'}});
      else await f.store.update('change',r=>({...r,policy:{...r.policy,retry:{maxPerSignature:1,maxResolver:1}}}));
      return inspect(...args);
    };
    assert.notEqual((await f.run(['stage','submit','review','review','--output',output])).code,0);
    assert.equal((await f.store.read('change')).verdict,null);assert.equal((await f.store.read('review')).state,'InReview');
  });
});

test('canonical source drift during permission verification blocks adoption without writing either record',async t=>{
  const f=await fixture(t),file=path.join(f.cwd,'scope.md');await writeFile(file,'original scope');
  await f.store.update('change',r=>({...r,canon:[{path:'scope.md',digest:hash('original scope')}]}));
  f.onVerify(()=>writeFile(file,'changed scope'));const before=await readFile(f.unitFile),goal=await f.goals.read('goal');
  assert.equal((await f.adopt(await f.request())).error,'CUSTODY_STALE');assert.deepEqual(await readFile(f.unitFile),before);assert.deepEqual(await f.goals.read('goal'),goal);
});

test('recipient-free stop rejects native drift and records only a verified adopted owner without closing it',async t=>{
  const f=await fixture(t);assert.equal((await f.adopt(await f.request())).code,0);
  await f.store.update('change',r=>({...r,state:'Stopped',stoppedFrom:'InReview',failures:[...r.failures,{path:'failure.json'}]}));
  await f.goals.transaction('goal',g=>({...g,revision:g.revision+1,goal:{...g.goal,status:'blocked',blocker:{unit:'change',reason:'access denied',resumeCondition:'access granted',evidence:'failure.json'}}}));
  const file=path.join(f.cwd,'stop.json');await writeFile(file,JSON.stringify({parentRuntime:f.owner,handoffContent:packet,resultFields:fields,classification:'authority'}));
  f.setLive({...f.owner,worker:{...f.owner.worker,threadId:'different'}});assert.notEqual((await f.run(['session-stop','change','--request',file])).code,0);
  assert.equal((await f.store.read('change')).stopReport,undefined);f.setLive(f.owner);
  assert.equal((await f.run(['session-stop','change','--request',file])).code,0);assert.deepEqual(f.effects,[]);
});
