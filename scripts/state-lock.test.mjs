import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {withStateLockGuard} from './lib/state-lock.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createLedgerStore} from './lib/ledger.mjs';

test('native ledger guard preserves nonblocking custody acquisition and marker metadata',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'state-guard-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const units=createUnitStateStore(root),ledger=createLedgerStore(root);
  await units.create({schema:'harness.unit/1',unit:'sample',kind:'impl',state:'Implementing'});
  const marker=path.join(root,'units/sample/.ledger.lock');
  await withStateLockGuard(marker,'LEDGER',async()=>{
    await assert.rejects(ledger.withLock('sample',()=>assert.fail('contended callback ran'),{wait:false}),{code:'LEDGER_LOCKED'});
    await assert.rejects(readFile(marker),{code:'ENOENT'});
  });
  await ledger.withLock('sample',async()=>{
    const held=JSON.parse(await readFile(marker));
    assert.equal(held.pid,process.pid);
    assert.equal(held.operation,'original-operation');
  },{wait:false,lockMetadata:{operation:'original-operation'}});
});

test('normal unit writes wait for the same recovery guard and retain unit metadata',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'state-guard-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const units=createUnitStateStore(root),marker=path.join(root,'units/sample/.lock');
  await units.create({schema:'harness.unit/1',unit:'sample',kind:'impl',state:'Implementing'});
  let pending,entered=false;
  await withStateLockGuard(marker,'UNIT',async()=>{
    pending=units.update('sample',async record=>{
      entered=true;
      assert.equal(JSON.parse(await readFile(marker)).operation,'original-operation');
      return {...record,checked:true};
    },{lockMetadata:{operation:'original-operation'}});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(entered,false);
    assert.equal((await units.read('sample')).revision,1);
  });
  assert.equal((await pending).revision,2);
  assert.equal(entered,true);
});
