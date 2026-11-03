import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {stopGoalSession} from './lib/continuity-stop.mjs';
import {finalizeSessionUnit} from './lib/session-flow.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {createAdapters} from './lib/adapters.mjs';
const packet = ['목표: work','수용 기준: criteria','작업관리: unit','결정: blocked','변경: retained','검증: no change','남은 일·위험: access','다음 단위 첫 행동: resume'].join('\n');
const fields={title:'Blocked',objective:'work',acceptance:'pending',tracking:'unit',decision:'blocked',changed:'none',verification:'none',remainingRisk:'access needed',nextFirstAction:'resume'};

test('stopped session transfers immutable blocker context, closes only the owner and remains resumable',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'continuity-stop-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'goal.md'); await writeFile(source,'goal');
 const digest=`sha256:${createHash('sha256').update('goal').digest('hex')}`;
 const goals=createContinuityStore(root),store=createUnitStateStore(root);
 await goals.create({goal:{id:'g1',objective:'work',criteria:['done'],remaining:['u1'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest}});
 await goals.transaction('g1',current=>({...current,revision:2,goal:{...current.goal,status:'blocked',blocker:{unit:'u1',reason:'access',resumeCondition:'access granted',evidence:'units/u1/failures/f1.json'}},bootstraps:[{unit:'u1',sessionId:'owner',incarnationId:'owner-1',cwd:root}]}));
 await store.create({schema:'harness.unit/1',unit:'u1',kind:'impl',state:'Stopped',stoppedFrom:'Implementing',continuity:{goalId:'g1'},failures:[{path:'units/u1/failures/f1.json'}],policy:{goal:{class:'product-prelaunch'}},openDecisions:[]});
 const parentRuntime={sessionId:'owner',incarnationId:'owner-1',cwd:root};
 const recipient={sessionId:'recipient',incarnationId:'recipient-1',cwd:root,executable:'worker'};
 let closed=false,delivered;
 const session={async observe(input){return input.recipient ? recipient : {...parentRuntime,closable:true,worker:{incarnationId:'worker-1'}}},
   async execute(input){if(input.effect==='session.close'){closed=true;return {sessionId:'owner',incarnationId:'owner-1',closed:true}}; const identity={sessionId:'recipient',incarnationId:'recipient-1',cwd:root}; delivered=input.args; return {...identity,task:{...identity,schema:'harness.task-receipt/1',effectKey:input.key,promptDigest:taskDigest('prompt'),threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets:['result','handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}}},
   async verify(input){return input.effect==='session.close' && closed ? {status:'completed',result:{sessionId:'owner',incarnationId:'owner-1',closed:true}} : {status:'unknown'}}};
 const adapters={...createAdapters(),session};
 const request={parentRuntime,returnTo:recipient,handoffContent:packet,resultFields:fields,classification:'authority'};
 const result=await stopGoalSession({stateRoot:root,unit:'u1',request,store,adapters});
 assert.equal(result.finalizePending,true); assert.equal(closed,false);
 const final=await finalizeSessionUnit({stateRoot:root,store,unit:'u1',adapters});
 assert.equal(final.state,'Stopped'); assert.equal(closed,true); assert.ok(delivered.goalDigest); assert.ok(delivered.handoffDigest);
 assert.equal((await goals.read('g1')).goal.status,'blocked');
 assert.equal((await store.read('u1')).sessionFinalization.closeReceipt.result.closed,true);
});

test('independent review returns only to its registered target owner and closes the reviewer', async t=>{
 const {prepareSessionReturn}=await import('./lib/continuity-return.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'continuity-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'goal.md');await writeFile(source,'goal');const digest=`sha256:${createHash('sha256').update('goal').digest('hex')}`;
 const goals=createContinuityStore(root),store=createUnitStateStore(root);
 await goals.create({goal:{id:'g2',objective:'work',criteria:['done'],remaining:['u1'],status:'active'},policy:{runtime:'orca',provider:'claude',account:'/account',model:'model',effort:'high',argv:['claude']},source:{path:source,digest}});
 await goals.transaction('g2',current=>({...current,revision:2,bootstraps:[{unit:'u1',sessionId:'target',incarnationId:'target-1',cwd:root}],reviews:[{unit:'review1',targetUnit:'u1',sessionId:'reviewer',incarnationId:'reviewer-1',cwd:root}]}));
 await store.create({schema:'harness.unit/1',unit:'review1',kind:'review',state:'Closed',targetUnit:'u1',continuity:{goalId:'g2'},policy:{goal:{class:'product-prelaunch'}},openDecisions:[]});
 const parentRuntime={sessionId:'reviewer',incarnationId:'reviewer-1',cwd:root},recipient={sessionId:'target',incarnationId:'target-1',cwd:root,executable:'worker'};
 let closed=false;
 const session={async observe(input){return input.recipient ? recipient : {...parentRuntime,closable:true,worker:{incarnationId:'w'}}},
  async execute(input){if(input.effect==='session.close'){closed=true;assert.equal(input.args.owner.sessionId,'reviewer');return {sessionId:'reviewer',incarnationId:'reviewer-1',closed:true}}; const identity={sessionId:'target',incarnationId:'target-1',cwd:root};return {...identity,task:{...identity,schema:'harness.task-receipt/1',effectKey:input.key,promptDigest:taskDigest('prompt'),threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets:['result','handoff','goal'].map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}))}}},
  async verify(input){return input.effect==='session.close'&&closed?{status:'completed',result:{sessionId:'reviewer',incarnationId:'reviewer-1',closed:true}}:{status:'unknown'}}};
 const adapters={...createAdapters(),session};
 const request={parentRuntime,returnTo:recipient,handoffContent:packet,resultFields:fields};
 await assert.rejects(prepareSessionReturn({stateRoot:root,unit:'review1',request:{...request,returnTo:{...recipient,sessionId:'other'}},store,adapters,mode:'review'}),{code:'CONTINUITY_INVALID'});
 assert.equal((await prepareSessionReturn({stateRoot:root,unit:'review1',request,store,adapters,mode:'review'})).finalizePending,true);
 assert.equal((await finalizeSessionUnit({stateRoot:root,store,unit:'review1',adapters})).state,'Closed');
 assert.equal((await store.read('review1')).sessionFinalization.closeReceipt.result.closed,true);
});
