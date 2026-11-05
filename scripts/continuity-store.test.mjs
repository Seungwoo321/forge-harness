import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { acquireContinuityLock } from './lib/continuity-lock.mjs';

test('goal registration is durable and refuses a conflicting redefinition', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-store-')); t.after(() => rm(root, {recursive:true,force:true}));
  const store = createContinuityStore(root);
  const input = {goal:{id:'g1',objective:'deliver',criteria:['verified'],remaining:['u1'],status:'active'},policy:{runtime:'orca',provider:'codex',account:'/account/personal',model:'model',effort:'high',argv:['codex']},source:{path:'/work/goal.md',digest:`sha256:${'a'.repeat(64)}`}};
  const original = await store.create(input);
  assert.deepEqual(await store.create(input), original);
  assert.deepEqual(await createContinuityStore(root).read('g1'), original);
  await assert.rejects(store.create({...input,goal:{...input.goal,objective:'other'}}), {code:'GOAL_CONFLICT'});
  assert.deepEqual(await store.read('g1'), original);
  await store.transaction('g1', current => ({...current,revision:current.revision+1,bootstraps:[{unit:'u1'}]}));
  assert.equal((await store.create(input)).revision,2);
});

test('goal lock excludes live owners and is released after a process dies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-lock-')); t.after(() => rm(root, {recursive:true,force:true}));
  const {mkdir} = await import('node:fs/promises');
  const store = createContinuityStore(root);
  const input = {goal:{id:'g2',objective:'deliver',criteria:['verified'],remaining:['u1'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:'/work/goal.md',digest:`sha256:${'a'.repeat(64)}`}};
  const directory=path.join(root,'goals','g2'); await mkdir(directory,{recursive:true});
  const lock=path.join(directory,'.lock');
  const held=await acquireContinuityLock(lock);
  await assert.rejects(store.create(input),{code:'GOAL_LOCKED'});
  await held.close();
  assert.equal((await store.create(input)).revision,1);
  const script=`import {acquireContinuityLock} from ${JSON.stringify(new URL('./lib/continuity-lock.mjs',import.meta.url).href)}; await acquireContinuityLock(process.argv[1]); console.log('ready'); setInterval(()=>{},1000)`;
  const owner=spawn(process.execPath,['--input-type=module','-e',script,lock],{stdio:['ignore','pipe','pipe']});
  t.after(()=>owner.kill());
  await once(owner.stdout,'data');
  await assert.rejects(store.create(input),{code:'GOAL_LOCKED'});
  owner.kill('SIGKILL'); await once(owner,'exit');
  let recovered;
  for(let attempt=0;attempt<50;attempt++) {
    try { recovered=await store.create(input); break; }
    catch(error) { if(error.code!=='GOAL_LOCKED') throw error; await new Promise(resolve=>setTimeout(resolve,20)); }
  }
  assert.equal(recovered?.revision,1);
});
