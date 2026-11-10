import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';

test('a retained Delivered predecessor cannot be changed by another unit update',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'retained-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createUnitStateStore(root),goals=createContinuityStore(root);
  await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:{path:'/source',digest:`sha256:${'a'.repeat(64)}`}});
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Delivered',continuity:{goalId:'g'},accepted:{head:'old',contentFingerprint:'tree'},acceptance:[],evidence:[],stages:[]});
  await goals.transaction('g',goal=>({...goal,revision:goal.revision+1,transfers:[{unit:'u',successor:'next',deliveredContinuation:true}]}));
  const before=await store.read('u');
  await assert.rejects(store.update('u',record=>({...record,state:'SelfGated',accepted:null})),{code:'CONTINUITY_RETAINED'});
  assert.deepEqual(await store.read('u'),before);
});
