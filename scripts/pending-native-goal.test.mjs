import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLedgerStore,executeEffect} from './lib/ledger.mjs';
const digest=`sha256:${'a'.repeat(64)}`;
test('host receiver creation survives an uncertain startup before any native input fence',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'created-native-receiver-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=createLedgerStore(root),receiver={runtime:'orca',sessionId:'created',incarnationId:'original',cwd:root};
 const args={unit:'u',role:'review',attempt:1,cwd:root,handoffPath:path.join(root,'handoff.md'),handoffDigest:digest,goalPath:path.join(root,'goal.json'),goalDigest:digest};
 let executes=0;
 const adapter={now:()=> '2026-01-01T00:00:00Z',execute:async input=>{executes++;await input.submission.bindReceiver(receiver);throw Error('foreground not ready');},verify:async input=>{
  assert.deepEqual(input.submission.receiver,receiver);
  await assert.rejects(input.submission.bindReceiver({...receiver,sessionId:'other'}),{code:'EFFECT_UNCERTAIN'});
  return {status:'unknown'};
 }};
 const run=()=>executeEffect({unit:'u',effect:'session.start',args,policy:{goal:{class:'product-prelaunch'}},context:{productOwned:true},store,adapter});
 await run();await run();const rows=await store.withLock('u',l=>l.read());
 assert.equal(executes,1);assert.equal(rows.filter(r=>r.event==='receiver').length,1);assert.equal(rows.filter(r=>['submission','confirmation','result'].includes(r.event)).length,0);
});
test('only positively verified exact pending native goals can cross the unused Return boundary',async t=>{
 for(const exact of [true,false])for(const absent of [true,false])await t.test(`${exact}/${absent}`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'pending-native-goal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createLedgerStore(root),args={unit:'u',role:'implementation',attempt:1,cwd:root,handoffPath:path.join(root,'handoff.md'),handoffDigest:digest,goalPath:path.join(root,'goal.json'),goalDigest:digest};
  const binding={runtime:'orca',sessionId:'receiver',incarnationId:'incarnation',cwd:root,executable:'codex',pid:42,threadId:'thread',promptDigest:digest,goalDigest:digest,packets:[{path:args.handoffPath,digest},{path:args.goalPath,digest}]};
  let executions=0,checks=0;
  const adapter={now:()=> '2026-01-01T00:00:00Z',execute:async input=>{executions++;await input.submission.mark(binding);throw Error('native composer did not settle before Return');},verify:async input=>{
   checks++;if(checks===1)return {status:'unknown',verify:{code:'SESSION_TASK_UNVERIFIED',nativeRequestAbsent:absent,exactPendingComposer:exact}};
   assert.equal(input.submission.pendingDraft,exact&&absent);
   if(exact&&absent){await input.submission.confirm(binding);return {status:'completed',result:{started:true}};}
   return {status:'unknown',verify:{code:'SESSION_TASK_UNVERIFIED',message:'native goal or packet delivery has not started'}};
  }};
  const run=()=>executeEffect({unit:'u',effect:'session.start',args,policy:{goal:{class:'product-prelaunch'}},context:{productOwned:true},store,adapter});
  await run();await run();await run();const rows=await store.withLock('u',l=>l.read());
  assert.equal(executions,1);assert.equal(rows.filter(row=>row.event==='intent').length,1);assert.equal(rows.filter(row=>row.event==='submission').length,1);assert.equal(rows.filter(row=>row.event==='confirmation').length,Number(exact&&absent));
 });
});
