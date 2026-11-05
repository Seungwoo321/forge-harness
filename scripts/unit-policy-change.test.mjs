import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'forge-policy-change-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, 'state'), store = createUnitStateStore(stateRoot), unit = 'unit-a';
  await store.create({ schema:'harness.unit/1', unit, revision:0, kind:'chore', state:'Scoped', request:{text:'Repair',userInputRef:'user-request'},
    policy:{goal:{class:'task'},delivery:'none'}, policyOverrides:{review:{mode:'required',by:'session',triggers:[]}},
    stages:[], evidence:[{gate:'tests',status:'passed'}], findings:[{id:'F-1',resolvedAt:'earlier'}], failures:[{signature:'prior'}] });
  await store.update(unit, r => ({...r,state:'Accepted',accepted:{head:'h',contentFingerprint:'c'},reviewDecision:{head:'h'},reviewedHead:'h',verdict:'ship'}));
  let authorized = true;
  const adapters = {now:()=> '2026-01-01T00:00:00Z',provider:{async verifyUserInput(input){return {...input,verified:authorized && input.userInputRef==='user-request' && input.effect==='unit.policy.change'};}}};
  const read = () => store.read(unit);
  const request = async (overrides={}) => ({id:'change-1',expectedRevision:(await read()).revision,delivery:'merge',reason:'User selected merge',...overrides});
  const run = async (body, ref='user-request') => {
    const file=path.join(cwd,`request-${body.id}.json`); await writeFile(file,JSON.stringify(body));
    const output=await runUnitCli(['unit','policy','change',unit,'--request',file,'--user-input',ref],{cwd,stateRoot,adapters});
    return JSON.parse(output.split('\n').at(-1).slice(7));
  };
  return {cwd,stateRoot,store,unit,read,request,run,deny:()=>{authorized=false;}};
}

test('public policy change preserves history, revalidates acceptance and retries idempotently', async t => {
  const f=await fixture(t), before=await f.read(), request=await f.request();
  const progressOutput=await runUnitCli(['unit','progress',f.unit],{cwd:f.cwd,stateRoot:f.stateRoot,adapters:{}});
  const progress=JSON.parse(progressOutput.split('\n').at(-1).slice(7));
  assert.equal(progress.revision,before.revision); assert.equal(progress.effectiveDelivery,'none'); assert.equal(progress.state,'Accepted');
  const result=await f.run(request); assert.equal(result.code,0,JSON.stringify(result));
  const after=await f.read(); assert.equal(after.state,'SelfGated'); assert.equal(after.policy.delivery,'none');
  assert.equal(after.policyOverrides.delivery,'merge'); assert.equal(after.accepted,null);
  assert.deepEqual(after.evidence,before.evidence); assert.deepEqual(after.findings,before.findings); assert.deepEqual(after.failures,before.failures);
  assert.deepEqual(after.policyChanges[0].previousAcceptance,before.accepted); assert.equal(after.policyChanges[0].before,'none');
  assert.equal(after.policyChanges[0].requestDigest,effectArgsDigest({request,userInputRef:'user-request'}));
  assert.equal((await f.run(request)).change.duplicate,true); assert.deepEqual(await f.read(),after);
  assert.equal((await f.run({...request,delivery:'push'})).error,'POLICY_CHANGE_CONFLICT');
});

test('public review policy change permits mandatory review without changing delivery or prior evidence', async t => {
  const f=await fixture(t);
  await f.store.update(f.unit,record=>({...record,policyOverrides:{review:{mode:'none',by:'session',triggers:[]}}}));
  const before=await f.read(), request={id:'review-change',expectedRevision:before.revision,review:{mode:'required',by:'session',triggers:[]},reason:'User authorized independent review'};
  const result=await f.run(request);assert.equal(result.code,0,JSON.stringify(result));
  const after=await f.read();assert.equal(after.state,'SelfGated');assert.equal(after.policyOverrides.review.mode,'required');
  assert.equal(after.policy.delivery,'none');assert.deepEqual(after.evidence,before.evidence);assert.equal(after.accepted,null);
  assert.equal((await f.run(request)).change.duplicate,true);
  assert.equal((await f.run({...request,id:'invalid',expectedRevision:after.revision,review:{mode:'required'}})).error,'POLICY_CHANGE_INVALID');
});

test('unauthorized, stale, unsafe and uncertain changes never mutate state', async t => {
  const f=await fixture(t); let before=await f.read(); const request=await f.request();
  f.deny(); assert.equal((await f.run(request)).error,'EFFECT_APPROVAL_REQUIRED'); assert.deepEqual(await f.read(),before);
  assert.equal((await f.run({...request,expectedRevision:request.expectedRevision+1})).error,'POLICY_CHANGE_STALE');
  assert.equal((await f.run({...request,delivery:'invalid'})).error,'POLICY_CHANGE_INVALID');
  await createLedgerStore(f.stateRoot).withLock(f.unit, ledger=>ledger.append({event:'intent',seq:1,effect:'git.push',key:'pending'}));
  assert.equal((await f.run(request)).error,'EFFECT_UNCERTAIN'); assert.deepEqual(await f.read(),before);
  await f.store.update(f.unit,r=>({...r,state:'Closed'})); before=await f.read();
  assert.equal((await f.run({...request,expectedRevision:before.revision})).error,'INVALID_TRANSITION'); assert.deepEqual(await f.read(),before);
});

test('concurrent different policy requests serialize at the unit revision', async t => {
  const f=await fixture(t), revision=(await f.read()).revision;
  const [a,b]=await Promise.all([f.run(await f.request({id:'one',expectedRevision:revision})),f.run(await f.request({id:'two',expectedRevision:revision,delivery:'push'}))]);
  assert.deepEqual([a.code,b.code].sort(),[0,1]);
  assert.equal([a,b].find(item=>item.code!==0).error,'POLICY_CHANGE_STALE');
  assert.equal((await f.read()).policyChanges.length,1);
});

test('installed executable loads a provider and applies an authorized policy change', async t => {
  const f=await fixture(t), request=await f.request();
  const file=path.join(f.cwd,'request.json'), adapter=path.join(f.cwd,'provider.mjs');
  await writeFile(file,JSON.stringify(request));
  await writeFile(adapter,"export function createRuntimeAdapters(){return {provider:{async verifyUserInput(input){return {...input,verified:input.userInputRef==='user-request' && input.effect==='unit.policy.change'}}}}}");
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./unit.mjs',import.meta.url)),'unit','policy','change',f.unit,'--request',file,'--user-input','user-request','--adapters',adapter,'--state-root',f.stateRoot,'--project-root',f.cwd],{cwd:f.cwd,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr+child.stdout); assert.match(child.stdout,/Policy changed for unit-a/);
  assert.equal((await f.read()).policyOverrides.delivery,'merge');
});

test('legacy open stages block changes and a later definitive effect result permits them', async t => {
  const f=await fixture(t);
  await f.store.update(f.unit,r=>({...r,state:'SelfGated',stages:[{name:'implement',attempt:1,startedAt:'2026-01-01'}]}));
  let request=await f.request(); assert.equal((await f.run(request)).error,'INVALID_TRANSITION');
  await f.store.update(f.unit,r=>({...r,stages:[{name:'implement',attempt:1,startedAt:'2026-01-01',submittedAt:'2026-01-02'}]}));
  await createLedgerStore(f.stateRoot).withLock(f.unit,async ledger=>{
    await ledger.append({event:'intent',seq:1,key:'k',effect:'git.push'});
    await ledger.append({event:'result',seq:1,key:'k',result:{status:'uncertain'}});
    await ledger.append({event:'result',seq:1,key:'k',result:{status:'completed'}});
  });
  request=await f.request(); assert.equal((await f.run(request)).code,0);
});
