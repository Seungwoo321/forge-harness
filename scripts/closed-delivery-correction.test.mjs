import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {recoverGoalCompletion} from './lib/completion-recover.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {finishSessionUnit} from './lib/session-flow.mjs';

const hash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'closed-omission-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=createUnitStateStore(root),goals=createContinuityStore(root),ledger=createLedgerStore(root);
 const source=path.join(root,'goal.md');await writeFile(source,'goal');
 await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy:{runtime:'orca',provider:'codex',account:'/account',model:'model',effort:'low',argv:['codex']},source:{path:source,digest:hash('goal')}});
 const owner={runtime:'orca',sessionId:'owner',incarnationId:'owner-1',cwd:root,worker:{executable:'/bin/codex',pid:42,threadId:'thread',incarnationId:'owner-1'}};
 const proof=[{criterion:'done',unit:'u',acceptance:'AC-1'}];
 await goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,status:'complete',remaining:[]},completion:{unit:'u',proof},bootstraps:[{unit:'u',sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd:root}]}));
 const resultPath=path.join(root,'old-result.md');await writeFile(resultPath,'original incorrect completion\n');
 await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Closed',continuity:{goalId:'g'},policy:{goal:{class:'product-prelaunch'},delivery:'merge',review:{mode:'required',by:'session',triggers:[]}},scopePaths:['original.mjs'],
  accepted:{head:'old',contentFingerprint:'old-content',tree:'a'.repeat(40)},reviewDecision:{required:true},reviewedHead:'old',verdict:'ship',failures:[{id:'original-failure'}],diff:{patch:'original patch'},handoff:{summary:'original handoff'},
  evidence:[{gate:'tests',status:'passed',covers:['AC-1']}],deliveryResult:{level:'none',effectRefs:[]},goalCompletion:{goalId:'g',revision:2,proof},result:'original incorrect completion',resultRef:{path:resultPath,digest:hash(await readFile(resultPath))}});
 const payload={goalComplete:true,goalProof:proof,parentRuntime:owner,delivery:{message:'approved merge'},resultFields:{verification:'incorrect earlier claim'}};
 const old=path.join(root,'finish.json'),provenance=path.join(root,'proof.json');await writeFile(old,JSON.stringify(payload));await writeFile(provenance,'trusted observation');
 const target={head:'old',contentFingerprint:'corrected-content',tree:'b'.repeat(40)};
 const request={kind:'closed-delivery-omission',id:'correction',expectedRevision:1,expectedGoalRevision:2,targetDigest:effectArgsDigest(target),finishRequest:{path:old,digest:hash(await readFile(old))},provenance:{path:provenance,digest:hash(await readFile(provenance))},correctionPaths:['correction.mjs'],requestedDelivery:'merge',owner,reason:'Correct the actual delivery omission'};
 const adapters={now:()=> '2026-01-01T00:00:00Z',git:{inspectUnit:async()=>target},session:{observe:async()=>owner},command:async()=>({exitCode:0,stdout:'correction.mjs\0'}),provider:{verifyUserInput:async b=>({...b,verified:b.userInputRef==='human'}),verifyClosedDeliveryCorrection:async({request,record,goal,target,rows,payload,checkpoint,...b})=>({...b,verified:true,originalPayloadVerified:true,noRemoteEffects:true,ownerAlive:true,closeNotApplied:true,oldExecutionSettled:true,queueSettled:true})}};
 const run=(extra={})=>recoverGoalCompletion({stateRoot:root,store,unit:'u',request,userInputRef:'human',adapters,...extra});
 return {root,store,goals,ledger,payload,old,request,target,adapters,run};
}
test('closed omission correction retains the old Closed proof and reopens only the same unit and goal',async t=>{
 const f=await fixture(t),before=await f.store.read('u'),goal=await f.goals.read('g');
 await f.run();const r=await f.store.read('u'),g=await f.goals.read('g');
 assert.equal(r.state,'Implementing');assert.equal(r.accepted,null);assert.equal(r.verdict,null);assert.equal(r.reviewDecision,null);
 assert.deepEqual(r.completionRecoveries[0].prior.accepted,before.accepted);assert.equal(r.completionRecoveries[0].prior.state,'Closed');assert.equal(r.completionRecoveries[0].prior.result,before.result);
 assert.deepEqual(r.completionRecoveries[0].prior,before);
 assert.deepEqual(r.failures,before.failures);assert.deepEqual(r.evidence[0],before.evidence[0]);assert.equal(r.evidence.at(-1).status,'stale');assert.deepEqual(r.scopePaths,before.scopePaths);
 assert.equal(g.goal.status,'active');assert.deepEqual(g.goal.remaining,['u']);assert.deepEqual(g.closedDeliveryCorrections[0].priorCompletion,goal.completion);
 assert.equal((await f.run()).duplicate,true);assert.equal((await f.store.read('u')).revision,r.revision);
});
test('closed omission refusals leave unit and goal unchanged',async t=>{
 const cases={explicit:async f=>{f.payload.requestedDelivery='none';await writeFile(f.old,JSON.stringify(f.payload));f.request.finishRequest.digest=hash(await readFile(f.old));},
  metadata:async f=>{f.payload.delivery={};await writeFile(f.old,JSON.stringify(f.payload));f.request.finishRequest.digest=hash(await readFile(f.old));},
  stale:async f=>{f.request.expectedRevision++;},target:async f=>{f.target.contentFingerprint='drift';},scope:async f=>{f.adapters.command=async()=>({exitCode:0,stdout:'foreign.mjs\0'});},
  authority:async f=>{f.adapters.provider.verifyUserInput=async b=>({...b,verified:false});},queue:async f=>{const v=f.adapters.provider.verifyClosedDeliveryCorrection;f.adapters.provider.verifyClosedDeliveryCorrection=async i=>({...await v(i),queueSettled:false});},
  owner:async f=>{f.adapters.session.observe=async()=>({...f.request.owner,worker:{...f.request.owner.worker,pid:99}});},
  successor:async f=>{await f.store.update('u',r=>({...r,next:{unit:'other'}}));f.request.expectedRevision++;},
  cap:async f=>{await f.store.update('u',r=>({...r,policy:{...r.policy,delivery:'none'}}));f.request.expectedRevision++;},
  plan:async f=>{await f.store.update('u',r=>({...r,deliveryPlan:{level:'merge'}}));f.request.expectedRevision++;},
  remote:async f=>{await f.ledger.withLock('u',async l=>{await l.append({event:'intent',effect:'git.push',seq:1,key:'remote'});await l.append({event:'result',seq:1,key:'remote',result:{head:'old'}});});}};
 for(const [name,patch]of Object.entries(cases))await t.test(name,async t=>{const f=await fixture(t);await patch(f);const r=await f.store.read('u'),g=await f.goals.read('g');await assert.rejects(f.run());assert.deepEqual(await f.store.read('u'),r);assert.deepEqual(await f.goals.read('g'),g);});
});
test('delivery presentation cannot silently default to none',async()=>{
 let writes=0;await assert.rejects(finishSessionUnit({unit:'u',store:{read:async()=>({state:'Accepted'}),update:async()=>{writes++;}},delivery:{message:'merge'}}),{code:'DELIVERY_LEVEL_REQUIRED'});assert.equal(writes,0);
});

async function interruptUnitCommit(f){
 const interrupted={...f.store,update:(unit,apply)=>f.store.update(unit,async record=>{await apply(record);throw Error('interrupted unit commit');})};
 await assert.rejects(f.run({store:interrupted}),/interrupted unit commit/);
 assert.equal((await f.store.read('u')).state,'Closed');assert.equal((await f.goals.read('g')).goal.status,'active');
}
test('interrupted correction resumes its exact post-goal checkpoint with fresh authority',async t=>{
 const f=await fixture(t);let checks=0;const verify=f.adapters.provider.verifyClosedDeliveryCorrection;
 f.adapters.provider.verifyClosedDeliveryCorrection=async input=>{checks++;return verify(input);};
 await interruptUnitCommit(f);await f.run();assert.equal(checks,2);assert.equal((await f.store.read('u')).state,'Implementing');
});
test('interrupted correction rejects changed owner, authority and post-goal relation',async t=>{
 for(const mode of ['owner','authority','goal'])await t.test(mode,async t=>{
  const f=await fixture(t);await interruptUnitCommit(f);
  if(mode==='owner')f.adapters.session.observe=async()=>({...f.request.owner,worker:{...f.request.owner.worker,pid:99}});
  if(mode==='authority')f.adapters.provider.verifyUserInput=async b=>({...b,verified:false});
  if(mode==='goal')await f.goals.transaction('g',g=>({...g,revision:g.revision+1,policy:{...g.policy,model:'changed'},goal:{...g.goal,remaining:['u','later']}}));
  const before=await f.store.read('u'),goal=await f.goals.read('g');await assert.rejects(f.run());
  assert.deepEqual(await f.store.read('u'),before);assert.deepEqual(await f.goals.read('g'),goal);
 });
});
