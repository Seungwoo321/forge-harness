import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore, executeEffect } from './lib/ledger.mjs';
import { lockDigest } from './lib/state-lock.mjs';
import { recoverStateLock } from './lib/lock-recovery.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { createAdapters } from './lib/adapters.mjs';

async function fixture(t, kind = 'unit', content = '{"pid":2147483647}') {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'lock-recovery-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const unit = 'sample', units = createUnitStateStore(stateRoot), ledger = createLedgerStore(stateRoot);
  await units.create({ schema:'harness.unit/1',unit,kind:'impl',state:'Implementing',revision:0,
    failures:[{signature:'original-failure'}],stages:[{name:'implement',checkpoint:'refs/example/original'}] });
  const file = path.join(stateRoot,'units',unit,kind === 'unit' ? '.lock' : '.ledger.lock');
  await writeFile(file,content);
  const evidence = path.join(stateRoot,'quiescence.json');
  await writeFile(evidence,'{"observation":"isolated legacy fixture is quiescent"}');
  const request = {kind,lockDigest:lockDigest(Buffer.from(content)),reason:'Recover the fenced original lock',evidence:{path:evidence,digest:lockDigest(await readFile(evidence))}};
  let observed;
  const input = { stateRoot,unit,request,userInputRef:'user:original-approval',adapters:{provider:{
    async verifyUserInput(input) { return {...input, verified:true}; },
    async verifyLockRecovery(binding) { observed=binding;return {...binding,verified:true,ownerFenced:true,legacyWritersFenced:true,legacyLeaseAbsent:true,
      externalEffects:binding.previousEffects.filter(row=>row.state==='unresolved').map(row=>({...row,status:'pending',evidence:'independent external observation'}))}; }
  }} };
  return { ...input,input,file,units,ledger,get observed(){return observed;} };
}

for (const kind of ['unit','ledger']) {
  test(`${kind} public recovery preserves original records and binds legacy ownership, authorization and effect state`, async t => {
    const f = await fixture(t,kind,'{"pid":2147483647}');
    const record = await f.units.read('sample');
    const receipt = await recoverStateLock(f.input);
    assert.equal(await readFile(receipt.archive,'utf8'),'{"pid":2147483647}');
    assert.deepEqual(await f.units.read('sample'),record);
    assert.deepEqual(f.observed.boundary,['ledger','unit']);
    assert.equal(f.observed.locks.find(lock=>lock.kind===kind).owner.pid,2147483647);
    assert.equal(f.observed.userInputRef,'user:original-approval');
    assert.equal(f.observed.lockDigest,f.request.lockDigest);
    assert.equal(f.observed.stateRoot,await (await import('node:fs/promises')).realpath(f.stateRoot));
    assert.match(f.observed.unitDigest,/^sha256:/);
    assert.equal(receipt.proof.legacyWritersFenced,true);
    assert.equal((await recoverStateLock(f.input)).duplicate,true);
    if(kind==='unit') await f.units.update('sample',record=>record);
    else await f.ledger.withLock('sample',()=>{});
  });
}

test('public CLI refuses a self-declared proof, missing verifier and absent real user authorization', async t => {
  const f = await fixture(t);
  const requestPath = path.join(f.stateRoot,'request.json');
  await writeFile(requestPath,JSON.stringify({...f.request,ownerFenced:true}));
  const output = await runUnitCli(['unit','lock','recover','sample','--state-root',f.stateRoot,'--project-root',f.stateRoot,
    '--request',requestPath,'--user-input','user:unverified'],{cwd:f.stateRoot,adapters:{}});
  const result = JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
  assert.equal(result.code,3);
  assert.equal(result.error,'LOCK_RECOVERY_UNVERIFIED');
  assert.equal(await readFile(f.file,'utf8'),'{"pid":2147483647}');
  f.input.adapters.provider.verifyLockRecovery=async binding=>({...binding,verified:false,ownerFenced:true,legacyWritersFenced:true,legacyLeaseAbsent:true,externalEffects:[]});
  await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
});

test('recovery rejects a live incarnation even when a provider would approve it', async t => {
  const io=createAdapters(),identity=await io.processIdentity(process.pid);
  const f=await fixture(t,'unit',JSON.stringify({protocol:'harness.state-lock/1',pid:process.pid,incarnation:identity.incarnation,token:'live'}));
  f.input.adapters.provider.verifyLockRecovery=()=>assert.fail('live owner passed to verifier');
  await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
});

test('changed lock, ledger, evidence, legacy fence or effect binding refuses recovery', async t => {
  for(const change of ['lock','ledger','unit','evidence','fence','lease','binding','mutated-binding']) {
    const f=await fixture(t);
    const verifier=f.input.adapters.provider.verifyLockRecovery;
    f.input.adapters.provider.verifyLockRecovery=async binding=>{
      const proof=await verifier(binding);
      if(change==='lock')await writeFile(f.file,'other');
      if(change==='unit'){const unitFile=path.join(f.stateRoot,'units/sample/unit.json'),record=JSON.parse(await readFile(unitFile));await writeFile(unitFile,JSON.stringify({...record,revision:record.revision+1}));}
      if(change==='mutated-binding'){binding.lockDigest='sha256:'+'0'.repeat(64);proof.lockDigest=binding.lockDigest;}
      if(change==='ledger')await writeFile(path.join(f.stateRoot,'units/sample/ledger.ndjson'),'{}\n');
      if(change==='evidence')await writeFile(f.request.evidence.path,'changed');
      if(change==='fence')proof.legacyWritersFenced=false;
      if(change==='lease')proof.legacyLeaseAbsent=false;
      if(change==='binding')proof.userInputRef='user:another';
      return proof;
    };
    await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
    assert.equal(await readFile(f.file,'utf8'),change==='lock'?'other':'{"pid":2147483647}');
  }
});

test('recovering only the ledger legacy marker keeps an independently pending external action unreconciled', async t => {
  const f=await fixture(t,'ledger');
  // This intent is the durable pre-dispatch boundary, not a fabricated completed effect.
  const {prepareEffect}=await import('./lib/policy.mjs');
  const args={repo:'example/repo',branch:'feature',tree:'tree',parent:'parent'},key=prepareEffect('git.commit',args).key;
  const intent={event:'intent',unit:'sample',seq:1,key,effect:'git.commit',args};
  const ledgerFile=path.join(f.stateRoot,'units/sample/ledger.ndjson');
  await writeFile(ledgerFile,JSON.stringify(intent)+'\n');
  const original=await readFile(ledgerFile);
  const result=await recoverStateLock(f.input);
  assert.equal(result.proof.externalEffects[0].status,'pending');
  assert.deepEqual(await readFile(ledgerFile),original);
  const run=()=>executeEffect({unit:'sample',effect:'git.commit',args,policy:{goal:{class:'task'},authority:{allow:[],deny:[]},delivery:'commit'},
    context:{inScope:true},store:f.ledger,adapter:{now:()=> 'time',execute:()=>assert.fail('external action duplicated'),verify:async()=>({status:'unknown'})}});
  assert.equal((await run()).status,'uncertain');
  assert.equal((await run()).status,'uncertain');
  assert.equal((await f.ledger.withLock('sample',store=>store.read())).filter(row=>row.event==='intent').length,1);
});

test('public CLI routes a verified recovery and retains the original effect bytes', async t => {
  const f=await fixture(t);
  const requestPath=path.join(f.stateRoot,'request.json');await writeFile(requestPath,JSON.stringify(f.request));
  const output=await runUnitCli(['unit','lock','recover','sample','--state-root',f.stateRoot,'--project-root',f.stateRoot,
    '--request',requestPath,'--user-input',f.userInputRef],{cwd:f.stateRoot,adapters:f.adapters});
  const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
  assert.equal(result.code,0);assert.equal(result.recovery.proof.ownerFenced,true);
});

test('independent recovery contenders and SIGKILL during verification preserve the same recovery boundary', {timeout:20000}, async t => {
  const {spawn}=await import('node:child_process'),{once}=await import('node:events');
  const f=await fixture(t);
  const module=new URL('./lib/lock-recovery.mjs',import.meta.url).href;
  const source=`
import {once} from 'node:events';
import {recoverStateLock} from ${JSON.stringify(module)};
const [input,pause]=process.argv.slice(1);const args=JSON.parse(input);
args.adapters={provider:{verifyUserInput:async input=>({...input,verified:true}),verifyLockRecovery:async binding=>{if(pause==='pause'){process.send('verifying');await once(process,'message');}
 return {...binding,verified:true,ownerFenced:true,legacyWritersFenced:true,legacyLeaseAbsent:true,externalEffects:[]};}}};
try{const result=await recoverStateLock(args);process.send(result.duplicate?'duplicate':'recovered');}catch(error){process.send(error.code);}
process.disconnect();
`;
  function worker(pause='') {
    const child=spawn(process.execPath,['--input-type=module','-e',source,JSON.stringify({...f.input,adapters:undefined}),pause],{stdio:['ignore','ignore','inherit','ipc']});
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;}});
    return child;
  }
  const crashed=worker('pause');assert.equal((await once(crashed,'message'))[0],'verifying');
  const end=once(crashed,'exit');crashed.kill('SIGKILL');await end;
  assert.equal(await readFile(f.file,'utf8'),'{"pid":2147483647}');
  const contenders=Array.from({length:4},()=>worker());
  const outcomes=await Promise.all(contenders.map(child=>once(child,'message').then(([value])=>value)));
  assert.equal(outcomes.filter(value=>value==='recovered').length,1);
  assert.equal(outcomes.filter(value=>value==='duplicate').length,3);
  assert.equal((await f.units.read('sample')).failures[0].signature,'original-failure');
});

test('live, malformed and reserved markers are never reclaimed by provider claims',async t=>{
  for(const marker of ['', '{"pid":', '{}', '{"pid":0}', JSON.stringify({pid:process.pid}),
    JSON.stringify({protocol:'harness.legacy-fence/1',purpose:'legacy-fence',pid:2147483647})]) {
    const f=await fixture(t,'unit',marker);
    f.input.adapters.provider.verifyLockRecovery=()=>assert.fail('unsafe marker delegated to provider');
    await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
    assert.equal(await readFile(f.file,'utf8'),marker);
  }
});

test('a live or reserved other marker fences recovery of the indicated marker',async t=>{
  for(const marker of [JSON.stringify({pid:process.pid}), JSON.stringify({purpose:'legacy-fence',pid:2147483647})]) {
    const f=await fixture(t);
    await writeFile(path.join(f.stateRoot,'units/sample/.ledger.lock'),marker);
    await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
    assert.equal(await readFile(f.file,'utf8'),'{"pid":2147483647}');
  }
});

test('a recorded pending result still requires an external observation and preserves the original ledger',async t=>{
  const f=await fixture(t,'ledger');
  const rows=[{event:'intent',seq:1,key:'original-key',effect:'session.close',args:{session:'original'}},
    {event:'result',seq:1,key:'original-key',result:{status:'pending'}}];
  const ledgerFile=path.join(f.stateRoot,'units/sample/ledger.ndjson');
  const bytes=rows.map(row=>JSON.stringify(row)+'\n').join('');await writeFile(ledgerFile,bytes);
  const receipt=await recoverStateLock(f.input);
  assert.equal(receipt.proof.previousEffects[0].state,'unresolved');
  assert.match(receipt.proof.previousEffects[0].resultDigest,/^sha256:/);
  assert.equal(receipt.proof.externalEffects[0].status,'pending');
  assert.equal(await readFile(ledgerFile,'utf8'),bytes);
});

test('live PID with different opaque incarnation cannot be recovered',async t=>{
  const marker=JSON.stringify({protocol:'harness.state-lock/1',pid:process.pid,incarnation:'opaque:previous-process',token:'previous-operation'});
  const f=await fixture(t,'unit',marker);
  await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
  assert.equal(await readFile(f.file,'utf8'),marker);
});

test('replay requires original archive bytes even when receipt exists',async t=>{
  for(const missing of [true,false]) {
    const f=await fixture(t),receipt=await recoverStateLock(f.input);
    if(missing) await rm(receipt.archive); else await writeFile(receipt.archive,'different');
    await assert.rejects(recoverStateLock(f.input),{code:'LOCK_RECOVERY_UNVERIFIED'});
  }
});

test('null, running and retired results preserve exact unresolved effect semantics',async t=>{
  const {effectArgsDigest}=await import('./lib/approvals.mjs');
  for(const state of ['running',null,'retired']) {
    const f=await fixture(t),intent={event:'intent',seq:1,key:'original',effect:'session.start',args:{}};
    const rows=[intent,{event:'result',seq:1,key:'original',result:state===null?null:{status:state==='retired'?'unknown':state}}];
    if(state==='retired')rows.push({event:'session-start-recovery',seq:1,key:'original',intentDigest:effectArgsDigest(intent)});
    const ledgerFile=path.join(f.stateRoot,'units/sample/ledger.ndjson'),bytes=rows.map(JSON.stringify).join('\n')+'\n';
    await writeFile(ledgerFile,bytes);
    const receipt=await recoverStateLock(f.input);
    assert.equal(receipt.proof.previousEffects[0].state,state==='retired'?'retired':'unresolved');
    assert.equal(receipt.proof.externalEffects.length,state==='retired'?0:1);
    assert.equal(await readFile(ledgerFile,'utf8'),bytes);
  }
});

test('scalar approval must authorize the exact recovery binding',async t=>{
  for(const field of [null,'bindingDigest','argsDigest','userInputRef']) {
    const f=await fixture(t);
    if(field===null)delete f.input.adapters.provider.verifyUserInput;
    else f.input.adapters.provider.verifyUserInput=async input=>({...input,verified:true,[field]:'changed'});
    await assert.rejects(recoverStateLock(f.input),{code:'EFFECT_APPROVAL_REQUIRED'});
    assert.equal(await readFile(f.file,'utf8'),'{"pid":2147483647}');
  }
});
