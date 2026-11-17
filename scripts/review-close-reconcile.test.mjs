import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {prepareEffect} from './lib/policy.mjs';
import {finalizeSessionUnit} from './lib/session-flow.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';

async function fixture(t,change) {
  const stateRoot=await mkdtemp(path.join(tmpdir(),'review-reconcile-'));
  t.after(()=>rm(stateRoot,{recursive:true,force:true}));
  const store=createUnitStateStore(stateRoot),ledger=createLedgerStore(stateRoot),unit='review';
  const resultPath=path.join(stateRoot,'result.md');await writeFile(resultPath,'accepted result');
  const owner={sessionId:'reviewer',incarnationId:'original-review',cwd:stateRoot};
  const recipient={sessionId:'original-recipient',incarnationId:'original-owner',cwd:stateRoot};
  const plan={mode:'review',owner,recipient,recipientCustody:{ownership:'existing',owner:recipient},resultPath,resultDigest:taskDigest('accepted result')};
  const args={...plan,cwd:stateRoot,session:recipient.sessionId,incarnation:recipient.incarnationId};
  const deliveryKey=prepareEffect('session.deliver',args).key;
  const receipt={...recipient,task:{schema:'harness.task-receipt/1',effectKey:deliveryKey,...recipient,promptDigest:taskDigest('prompt'),
    threadId:'native-original',requestId:'request',turnId:'turn',activityId:'read',packets:[{path:resultPath,digest:plan.resultDigest}]}};
  const closeArgs={owner,recipient,session:owner.sessionId,incarnation:owner.incarnationId,resultDigest:plan.resultDigest,deliveryKey};
  const closeKey=prepareEffect('session.close',closeArgs).key;
  const rows=[{event:'intent',unit,seq:1,effect:'session.deliver',key:deliveryKey,args},
    {event:'result',unit,seq:1,key:deliveryKey,result:receipt},
    {event:'intent',unit,seq:2,effect:'session.close',key:closeKey,args:closeArgs}];
  if(change==='missing-delivery')rows.splice(1,1);
  if(change==='wrong-recipient')receipt.sessionId=receipt.task.sessionId='different';
  if(change==='foreign-close')rows.at(-1).args.session='different';
  await store.create({schema:'harness.unit/1',unit,kind:change==='impl'?'impl':'review',state:'Closed',policy:{goal:{class:'task'},delivery:'none'},sessionFinalization:plan,stages:[{name:'review',verdict:'ship'}]});
  await ledger.withLock(unit,async log=>{for(const row of rows)await log.append(row);});
  let calls=0;
  const adapters={now:()=> 'time',session:{observe:async()=>assert.fail('missing recipient must never be impersonated'),execute:async()=>assert.fail('reconciliation cannot execute'),verify:async input=>{
    calls++;assert.equal(input.effect,'session.close');assert.equal(input.key,closeKey);assert.deepEqual(input.args,closeArgs);assert.equal(input.reconcileOnly,true);
    if(change==='unknown'||change==='not-applied')return {status:change};
    if(change==='drift'&&calls===1)await writeFile(resultPath,'changed');
    return {status:'completed',result:{closed:true,sessionId:change==='wrong-close'?'foreign':owner.sessionId,incarnationId:owner.incarnationId}};
  }}};
  return {stateRoot,store,ledger,unit,rows,adapters,calls:()=>calls,run:()=>finalizeSessionUnit({stateRoot,store,unit,adapters,reconcileOnly:true})};
}

test('public verification-only finalization reconciles original close without observing dead recipient or executing',async t=>{
  const f=await fixture(t),before=await f.store.read(f.unit);
  const output=await runUnitCli(['unit','finalize',f.unit,'--reconcile-only'],{stateRoot:f.stateRoot,cwd:f.stateRoot,adapters:f.adapters});
  const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.calls(),2);
  const rows=await f.ledger.withLock(f.unit,log=>log.read());
  assert.deepEqual(rows.slice(0,3),f.rows);assert.equal(rows.filter(row=>row.event==='intent').length,2);
  assert.equal(rows.at(-1).seq,2);assert.equal(rows.at(-1).result.closed,true);
  const after=await f.store.read(f.unit);
  assert.deepEqual(after.stages,before.stages);assert.deepEqual(after.sessionFinalization.recipientCustody,before.sessionFinalization.recipientCustody);
  assert.equal(after.sessionFinalization.closeReceipt.result.closed,true);
});

for(const change of ['missing-delivery','wrong-recipient','foreign-close','impl','wrong-close','unknown','not-applied','drift'])test(`reconciliation refuses ${change} without an external execution or new intent`,async t=>{
  const f=await fixture(t,change),before=await readFile(path.join(f.stateRoot,'units/review/unit.json'));
  if(['unknown','not-applied','wrong-close'].includes(change))assert.equal((await f.run()).code,3);
  else await assert.rejects(f.run());
  assert.deepEqual(await readFile(path.join(f.stateRoot,'units/review/unit.json')),before);
  const rows=await f.ledger.withLock(f.unit,log=>log.read());
  assert.deepEqual(rows.filter(row=>row.event==='intent'),f.rows.filter(row=>row.event==='intent'));
});


test('a later unresolved effect prevents close reconciliation',async t=>{
  const f=await fixture(t);
  await f.ledger.withLock(f.unit,log=>log.append({event:'intent',seq:3,key:'other',effect:'session.start',args:{}}));
  await assert.rejects(f.run(),{code:'EFFECT_UNCERTAIN'});
  assert.equal(f.calls(),0);
});

test('successful replay preserves the original close receipt and unit bytes',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).code,0);
  const file=path.join(f.stateRoot,'units/review/unit.json'),before=await readFile(file);
  assert.equal((await f.run()).code,0);assert.deepEqual(await readFile(file),before);
});

test('concurrent finalizers never create a new intent or overwrite the first receipt',async t=>{
  const f=await fixture(t),results=await Promise.allSettled([f.run(),f.run()]);
  assert.ok(results.some(result=>result.status==='fulfilled'&&result.value.code===0));
  const rows=await f.ledger.withLock(f.unit,log=>log.read());
  assert.equal(rows.filter(row=>row.event==='intent').length,2);
  assert.equal(rows.filter(row=>row.event==='result'&&row.seq===2).length,1);
  assert.equal((await f.store.read(f.unit)).sessionFinalization.closeReceipt.result.closed,true);
});

test('verification-only flag cannot be silently ignored by other commands',async t=>{
  const f=await fixture(t),file=path.join(f.stateRoot,'units/review/unit.json'),before=await readFile(file);
  for(const args of [['unit','finish',f.unit],['unit','effect',f.unit],['goal','create','other']]) {
    const output=await runUnitCli([...args,'--reconcile-only'],{stateRoot:f.stateRoot,cwd:f.stateRoot,adapters:f.adapters});
    const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.error,'CLI_USAGE');
  }
  assert.deepEqual(await readFile(file),before);assert.equal(f.calls(),0);
});
