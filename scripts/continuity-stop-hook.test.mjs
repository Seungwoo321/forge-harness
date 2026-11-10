import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectArgsDigest } from './lib/approvals.mjs';
import { nativeOwner } from './lib/continuity-custody.mjs';
import { prepareEffect } from './lib/policy.mjs';
import { taskDigest } from './lib/session-task.mjs';

const hook = fileURLToPath(new URL('./continuity-stop-hook.mjs', import.meta.url));
test('managed Stop continues unfinished work and permits verified transfer without looping', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'continuity-hook-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await mkdir(path.join(root,'goals','g'),{recursive:true});
  await mkdir(path.join(root,'units','u'),{recursive:true});
  const goal = {goal:{status:'active'}};
  const record = {state:'Implementing',kind:'impl'};
  const save = async () => {
    await writeFile(path.join(root,'goals','g','goal.json'),JSON.stringify(goal));
    await writeFile(path.join(root,'units','u','unit.json'),JSON.stringify(record));
  };
  const run = event => {
    const result = spawnSync(process.execPath,[hook],{env:{...process.env,FORGE_CONTINUITY_ROOT:root,FORGE_CONTINUITY_GOAL:'g',FORGE_CONTINUITY_UNIT:'u'},input:JSON.stringify(event),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  await save();
  assert.match(run({}).reason,/session-finish/);
  assert.match(run({stop_hook_active:true}).systemMessage,/handoff remains unresolved/);
  goal.goal.status='blocked'; record.state='Stopped'; await save();
  assert.match(run({}).reason,/session-stop/);
  record.sessionFinalization={closeReceipt:{status:'completed'}}; await save();
  assert.deepEqual(run({}),{});
  record.kind='review'; record.state='Closed'; delete record.sessionFinalization; await save();
  assert.match(run({}).reason,/session-return/);
  goal.goal.status='active';record.kind='impl';await save();
  assert.equal(run({}).decision,'block','closed unit before continuation commit still guards the active goal');
  await mkdir(path.join(root,'units','next'),{recursive:true});
  await writeFile(path.join(root,'units','next','unit.json'),JSON.stringify({state:'Implementing',kind:'impl'}));
  goal.transfers=[{unit:'u',successor:'next',sameSession:true}];await save();
  assert.equal(run({}).decision,'block','original environment must follow same-session custody');
  await writeFile(path.join(root,'units','next','unit.json'),JSON.stringify({state:'Stopped',kind:'impl'}));
  assert.match(run({}).reason,/session-stop/);
  goal.transfers=[];goal.goal.status='complete';await save();
  assert.deepEqual(run({}),{});
});

async function retained(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-stop-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const owner = {runtime:'cmux',sessionId:'owner',incarnationId:'owner-1',cwd:root,executable:'codex',pid:12,
    worker:{executable:'codex',pid:12,threadId:'owner-thread',incarnationId:'owner-1'}};
  const prior = {unit:'old',state:'Delivered',kind:'impl',continuity:{goalId:'g'},sessionFinalization:{owner,recipient:{sessionId:'parent'}}};
  const next = {unit:'next',state:'InReview',kind:'impl',continuity:{goalId:'g'}};
  const goal = {goal:{id:'g',status:'active',remaining:['next']},
    transfers:[{unit:'old',successor:'next',deliveredContinuation:true,unitDigest:effectArgsDigest(prior),requestDigest:'request'}],
    adoptions:[{unit:'next',ownership:'existing',requestDigest:'request',...owner,owner:nativeOwner(owner)}]};
  const save = async () => {
    for (const [file,value] of [['goals/g/goal.json',goal],['units/old/unit.json',prior],['units/next/unit.json',next]]) {
      await mkdir(path.dirname(path.join(root,file)),{recursive:true});
      await writeFile(path.join(root,file),JSON.stringify(value));
    }
  };
  const run = (event={}) => {
    const result = spawnSync(process.execPath,[hook],{encoding:'utf8',input:JSON.stringify(event),
      env:{...process.env,FORGE_CONTINUITY_ROOT:root,FORGE_CONTINUITY_GOAL:'g',FORGE_CONTINUITY_UNIT:'old'}});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  await save();return {root,owner,prior,next,goal,save,run};
}

test('AC-4 Stop follows verified delivered continuation without changing its retained predecessor',async t=>{
  const f=await retained(t),before=await readFile(path.join(f.root,'units/old/unit.json'));
  assert.equal(f.run().decision,'block');assert.match(f.run().reason,/Continue the authorized goal/);
  assert.doesNotMatch(f.run().reason,/reconcile the existing handoff/);
  f.next.state='Stopped';await f.save();assert.match(f.run().reason,/session-stop/);
  f.next.state='Closed';f.goal.goal.status='complete';await f.save();assert.deepEqual(f.run(),{});
  assert.deepEqual(await readFile(path.join(f.root,'units/old/unit.json')),before);
});

test('AC-4 Stop rejects stale, foreign, missing and cyclic delivered continuation proof',async t=>{
  for(const failure of ['predecessor','request','owner','goal','missing','cycle'])await t.test(failure,async t=>{
    const f=await retained(t);
    if(failure==='predecessor')f.prior.changed=true;
    if(failure==='request')f.goal.adoptions[0].requestDigest='foreign';
    if(failure==='owner')f.goal.adoptions[0].owner.worker.threadId='foreign';
    if(failure==='goal')f.next.continuity.goalId='foreign';
    if(failure==='missing')f.goal.adoptions=[];
    if(failure==='cycle')f.goal.transfers.push({unit:'next',successor:'old',sameSession:true});
    await f.save();const result=f.run();assert.equal(result.decision,'block');assert.match(result.reason,/Inspect the goal and unit state/);
  });
});

async function incoming(t) {
  const f=await retained(t);
  const reviewer={...f.owner,sessionId:'reviewer',incarnationId:'reviewer-1',pid:13,
    worker:{executable:'codex',pid:13,threadId:'review-thread',incarnationId:'reviewer-1'}};
  f.goal.reviews=[{unit:'review',targetUnit:'next',...reviewer}];
  const plan={mode:'review',owner:reviewer,recipient:structuredClone(f.owner)};
  for(const [name,text]of [['handoff','handoff\n'],['result','review result\n'],['goal','goal\n']]){
    plan[name+'Path']=path.join(f.root,name+'.txt');plan[name+'Digest']=taskDigest(text);await writeFile(plan[name+'Path'],text);
  }
  const review={unit:'review',kind:'review',state:'Closed',targetUnit:'next',continuity:{goalId:'g'},sessionFinalization:plan};
  const args={...plan,cwd:f.root,session:'owner',incarnation:'owner-1'},key=prepareEffect('session.deliver',args).key;
  const binding={runtime:'cmux',sessionId:'owner',incarnationId:'owner-1',cwd:f.root,executable:'codex',pid:12,threadId:'owner-thread',
    promptDigest:taskDigest(`Read ${plan.resultPath} (${plan.resultDigest}); follow its referenced handoffs. [delivery ${key}]`),goalDigest:plan.goalDigest,
    packets:['handoff','result','goal'].map(name=>({path:plan[name+'Path'],digest:plan[name+'Digest']})),route:'codex-native-queue/1'};
  const rows=[{event:'intent',effect:'session.deliver',seq:2,key,args},{event:'submission',seq:2,key,binding},
    {event:'confirmation',seq:2,key,binding:structuredClone(binding)}];
  const save=async()=>{await f.save();await mkdir(path.join(f.root,'units/review'),{recursive:true});
    await writeFile(path.join(f.root,'units/review/unit.json'),JSON.stringify(review));
    await writeFile(path.join(f.root,'units/review/ledger.ndjson'),rows.map(JSON.stringify).join('\n')+'\n');};
  await save();return {...f,review,rows,plan,save};
}

test('AC-4 a bound queued review permits a native turn boundary without claiming receipt or completion',async t=>{
  const f=await incoming(t),paths=['goals/g/goal.json','units/old/unit.json','units/next/unit.json','units/review/unit.json','units/review/ledger.ndjson'];
  const before=await Promise.all(paths.map(p=>readFile(path.join(f.root,p))));
  for(const event of [{},{stop_hook_active:true}]){
    const result=f.run(event);assert.equal(result.decision,undefined);assert.match(result.systemMessage,/Yield this turn/);
  }
  assert.deepEqual(await Promise.all(paths.map(p=>readFile(path.join(f.root,p)))),before);
  assert.equal(f.review.sessionFinalization.closeReceipt,undefined);
  assert.equal(f.rows.filter(r=>r.event==='result').length,0);assert.equal(f.goal.goal.status,'active');
});

test('AC-4 unconfirmed, retired, changed, completed or foreign review returns retain the guard',async t=>{
  for(const failure of ['unconfirmed','duplicate','order','binding','recipient','reviewer','thread','packet','key','retired','received','closed','cursor'])await t.test(failure,async t=>{
    const f=await incoming(t);
    if(failure==='unconfirmed')f.rows.pop();
    if(failure==='duplicate')f.rows.push(structuredClone(f.rows[1]));
    if(failure==='order')f.rows.reverse();
    if(failure==='binding')f.rows[2].binding.promptDigest='foreign';
    if(failure==='recipient')f.plan.recipient.sessionId='foreign';
    if(failure==='reviewer')f.goal.reviews[0].sessionId='foreign';
    if(failure==='thread')f.rows[1].binding.threadId='foreign';
    if(failure==='packet')await writeFile(f.plan.resultPath,'changed');
    if(failure==='key')f.rows[0].key='foreign';
    if(failure==='retired')f.rows.push({event:'delivered-rework',seq:2,key:f.rows[0].key,intentDigest:effectArgsDigest(f.rows[0])});
    if(failure==='received')f.rows.push({event:'result',seq:2,key:f.rows[0].key});
    if(failure==='closed')f.plan.closeReceipt={result:{closed:true}};
    if(failure==='cursor')f.goal.goal.remaining=['different'];
    await f.save();assert.equal(f.run().decision,'block');
  });
});
