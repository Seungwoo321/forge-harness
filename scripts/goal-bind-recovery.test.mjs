import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {recoverMissingGoalBinding} from './lib/goal-bind-recovery.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'goal-bind-recovery-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=path.join(root,'goal.md');await writeFile(source,'Original task and required recovery');
 const store=createUnitStateStore(root),goals=createContinuityStore(root);const policy={runtime:'cmux',provider:'codex',account:'/fixture-account',model:'model',effort:'high',argv:['codex']};
 await goals.create({goal:{id:'g',objective:'Original task',criteria:['verified'],remaining:['u'],status:'active'},source:{path:source,digest:hash(await readFile(source))},policy});
 const target={head:'head',contentFingerprint:'content'};
 const evidence=['typecheck','lint','tests','build','acceptance-coverage'].map(gate=>({gate,status:'passed',exit:0,covers:['AC-1'],failureClass:null,fingerprint:hash(gate),execution:{kind:'isolated-snapshot-v1',fingerprint:hash(gate)}}));
 await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Accepted',continuityRequired:true,request:{text:'Original work',userInputRef:'original-user'},
  policy:{goal:{class:'task'},review:{mode:'required',by:'session',triggers:[]}},head:target.head,contentFingerprint:target.contentFingerprint,accepted:{...target,basis:'review'},
  acceptance:[{id:'AC-1',text:'verified'}],reviewedHead:target.head,verdict:'ship',reviewDecision:{required:true,contentFingerprint:target.contentFingerprint},evidence,
  stages:[{name:'scope',attempts:[{n:1,endedAt:'done'}]},{name:'implement',attempts:[{n:1,endedAt:'done'}]}],failures:[{id:'first-failure'}],scopeAmendments:[{previous:['src'],added:['lib'],userInputRef:'operator'}],scopeApprovalCorrections:[{id:'original-human-correction'}]});
 const record=await store.read('u'),goal=await goals.read('g');
 const request={recover:true,id:'recover-1',goalId:'g',expectedRevision:record.revision,expectedGoalRevision:goal.revision,unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),targetDigest:effectArgsDigest(target),reason:'Human instructed continuation after the known blocker'};
 let proof=true,inspections=0;
 const adapters={now:()=> '2026-01-01T00:00:00Z',git:{inspectUnit:async()=>{inspections++;return target;}},provider:{verifyUserInput:async binding=>({...binding,verified:proof&&binding.userInputRef==='original-human'&&binding.originalRequestDigest===effectArgsDigest(record.request)})}};
 const run=(patch={})=>recoverMissingGoalBinding({stateRoot:root,store,unit:'u',request,userInputRef:'original-human',adapters,...patch});
 return {root,source,store,goals,record,goal,request,target,adapters,run,setProof:value=>{proof=value;},get inspections(){return inspections;}};
}

test('AC-2 public late binding preserves historical policy, failed evidence, stages and independent review without native custody',async t=>{
 const f=await fixture(t),beforeGoal=await readFile(path.join(f.root,'goals/g/goal.json'));const file=path.join(f.root,'request.json');await writeFile(file,JSON.stringify(f.request));
 const output=await runUnitCli(['unit','goal-bind','u','--request',file,'--user-input','original-human'],{stateRoot:f.root,adapters:f.adapters});const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.code,0,output);
 const bound=await f.store.read('u');assert.equal(bound.continuity.goalId,'g');assert.equal(bound.request.overallGoal.id,'g');assert.equal(bound.policy.session,undefined);
 for(const key of ['policy','evidence','stages','failures','accepted','acceptance','reviewDecision','scopeAmendments','scopeApprovalCorrections'])assert.deepEqual(bound[key],f.record[key],key);
 assert.equal(bound.goalBindings[0].previous.request.text,f.record.request.text);assert.deepEqual(await readFile(path.join(f.root,'goals/g/goal.json')),beforeGoal);
 const goal=await f.goals.read('g');assert.equal(goal.adoptions,undefined);assert.equal(goal.bootstraps,undefined);assert.equal(goal.transfers,undefined);
 const duplicate=await f.run();assert.equal(duplicate.duplicate,true);assert.deepEqual(await f.store.read('u'),bound);
 await assert.rejects(f.run({request:{...f.request,reason:'other'}}),{code:'GOAL_BIND_CONFLICT'});assert.deepEqual(await f.store.read('u'),bound);
});

test('AC-3 concurrent exact bindings commit one audit receipt',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.run(),f.run()]);assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal((await f.store.read('u')).goalBindings.length,1);assert.equal((await f.store.read('u')).revision,2);
});

test('untrusted, stale, already-owned, unfinished and drifted bindings fail without changing the unit or goal',async t=>{
 const cases={
  'operator input':async f=>f.setProof(false),
  'stale unit':async f=>{f.request.expectedRevision++;},
  'stale unit digest':async f=>{f.request.unitDigest=hash('stale');},
  'stale goal':async f=>{f.request.expectedGoalRevision++;},
  'stale goal digest':async f=>{f.request.goalDigest=hash('stale');},
  'other target':async f=>{f.request.targetDigest=hash('other');},
  'source changed':async f=>{await writeFile(f.source,'changed');},
  'missing verifier':async f=>{delete f.adapters.provider;},
  'target drift during verification':async f=>{let n=0;f.adapters.git.inspectUnit=async()=>++n===1?f.target:{...f.target,contentFingerprint:'changed'};},
  'goal concurrently refreshing':async f=>{f.adapters.provider.verifyUserInput=async binding=>{await assert.rejects(f.goals.transaction('g',g=>({...g,revision:g.revision+1})),{code:'GOAL_LOCKED'});return {...binding,verified:false};};},
 };
 for(const [name,patch]of Object.entries({bound:{continuity:{goalId:'another'}},open:{stages:[{name:'implement',attempts:[{n:2}]}]},delivery:{deliveryPlan:{}},owner:{sessionHistory:[{}]},review:{verdict:'fix'},evidence:{evidence:[]},unaccepted:{state:'Implementing',accepted:null}}))cases[name]=async f=>{
  await f.store.update('u',r=>({...r,...patch}));const r=await f.store.read('u');f.request.expectedRevision=r.revision;f.request.unitDigest=effectArgsDigest(r);
 };
 cases['pending external effect']=async f=>{await createLedgerStore(f.root).withLock('u',l=>l.append({event:'intent',seq:1,key:'pending',effect:'git.commit',args:{}}));};
 cases['old native intent even if settled']=async f=>{await createLedgerStore(f.root).withLock('u',async l=>{await l.append({event:'intent',seq:1,key:'native',effect:'session.start',args:{}});await l.append({event:'result',seq:1,key:'native',result:{}});});};
 cases['goal already has custody']=async f=>{await f.goals.transaction('g',g=>({...g,revision:g.revision+1,adoptions:[{unit:'u',sessionId:'existing'}]}));const g=await f.goals.read('g');f.request.goalDigest=effectArgsDigest(g);f.request.expectedGoalRevision=g.revision;};
 for(const [name,mutate]of Object.entries(cases))await t.test(name,async t=>{
  const f=await fixture(t);await mutate(f);const before=await f.store.read('u'),goalBytes=await readFile(path.join(f.root,'goals/g/goal.json'));await assert.rejects(f.run());assert.deepEqual(await f.store.read('u'),before);assert.deepEqual(await readFile(path.join(f.root,'goals/g/goal.json')),goalBytes);
 });
});
