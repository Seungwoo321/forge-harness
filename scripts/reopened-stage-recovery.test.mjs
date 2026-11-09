import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAdapters} from './lib/adapters.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';

async function fixture(t) {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'reopened-stage-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  const files=['source','second','third','fourth','fifth'];for(const file of files)await writeFile(path.join(cwd,file),'base');
  git('add','.');git('commit','-qm','base');const originalHead=git('rev-parse','HEAD'),branch=git('branch','--show-current');
  const stateRoot=path.join(cwd,'.git/work-state'),store=createUnitStateStore(stateRoot),adapters=createAdapters({repositoryRoot:cwd});
  const call=async(args,overrides={})=>{const output=await runUnitCli(args,{cwd,stateRoot,adapters:{...adapters,...overrides}});return JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));};
  await store.create({schema:'harness.unit/1',unit:'demo',kind:'impl',state:'Implementing',request:'work',policy:{goal:{class:'task'}},scopePaths:[...files,'base'],head:originalHead,contentFingerprint:'',stages:[],acceptance:[],evidence:[],findings:[],failures:[{id:'historical-failure'}],assumptions:[],openDecisions:[],canon:[],feedback:[]});
  const opened=await call(['unit','stage','open','demo','implement']);assert.equal(opened.code,0,JSON.stringify(opened));
  const input=JSON.parse(await readFile(opened.input,'utf8'));for(const file of files)await writeFile(path.join(cwd,file),'approved product');
  const output=path.join(cwd,'.git/output.json');await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'first',status:'done',summary:'implemented',changedPaths:files,coverage:[],assumptions:[],openDecisions:[]}));
  assert.equal((await call(['unit','stage','submit','demo','implement','--output',output])).code,0);
  git('add',...files);git('commit','-qm','implementation');const implementationHead=git('rev-parse','HEAD');
  // Seed the accepted fixture after its real completed implementation; recovery still uses public commands.
  await store.update('demo',r=>({...r,state:'Accepted',head:implementationHead,accepted:{head:implementationHead,contentFingerprint:r.contentFingerprint},reviewedHead:implementationHead,reviewDecision:{head:implementationHead},verdict:'ship',stages:[...r.stages,{name:'review',attempts:[{n:1,endedAt:'reviewed',result:'ship',inputDigest:'historical-review'}]}]}));
  const accepted=await store.read('demo');git('commit','--allow-empty','-qm','approved product tree');const approvedCommit=git('rev-parse','HEAD');
  const requestFile=path.join(cwd,'.git/request.json');await writeFile(requestFile,JSON.stringify({expectedRevision:accepted.revision,reason:'integrate authorized latest base',evidence:'approved-source'}));
  assert.equal((await call(['unit','reopen','demo','--request',requestFile])).code,0);const reopened=await store.read('demo');
  git('checkout','-qb','upstream',originalHead);await writeFile(path.join(cwd,'base'),'latest base');git('add','base');git('commit','-qm','latest base');const upstream=git('rev-parse','HEAD');git('checkout','-q',branch);git('merge','--no-ff','-qm','integrate latest base','upstream');
  const currentHead=git('rev-parse','HEAD');assert.notEqual(currentHead,approvedCommit);assert.equal(git('status','--porcelain'),'');assert.deepEqual(git('diff','--name-only',upstream).split('\n').sort(),files.sort());
  assert.equal((await call(['unit','scope','recheck','demo'])).code,0);assert.equal((await store.read('demo')).head,implementationHead);
  assert.equal((await call(['unit','stage','open','demo','implement'])).error,'CHECKPOINT_STALE');
  const orphan=path.join(stateRoot,'units/demo/stages/implement.2.input.json'),orphanBytes=await readFile(orphan),prior=reopened.stages.find(s=>s.name==='implement').attempts[0];
  const request={attempt:prior.n,inputDigest:prior.inputDigest,checkpointHead:prior.checkpointHead,newHead:currentHead};
  const restart=async(body=request,overrides={})=>{await writeFile(requestFile,JSON.stringify(body));return call(['unit','stage','restart','demo','implement','--request',requestFile],overrides);};
  return {cwd,git,call,restart,store,adapters,request,reopened,prior,currentHead,originalHead,orphan,orphanBytes,files};
}

test('completed implementation after public reopen binds current merged HEAD and preserves history/orphan input',async t=>{
  const f=await fixture(t),before=await f.store.read('demo'),index=await readFile(path.join(f.cwd,'.git/index'));
  assert.equal((await f.restart({...f.request,newHead:f.originalHead})).error,'STAGE_STALE');
  assert.equal((await f.restart()).code,0);const rebound=await f.store.read('demo'),old=rebound.stages.find(s=>s.name==='implement').attempts[0];
  for(const key of ['n','result','endedAt','checkpoint','checkpointCommit','checkpointHead','inputDigest','inputRevision'])assert.deepEqual(old[key],f.prior[key],key);
  assert.equal(old.restart.newHead,f.currentHead);assert.equal(old.restart.reopeningRevision,f.reopened.reopenings.at(-1).revision);assert.equal(old.restart.skipPendingAttempt,2);
  assert.deepEqual(rebound.failures,before.failures);assert.deepEqual(rebound.stages.find(s=>s.name==='review'),before.stages.find(s=>s.name==='review'));assert.equal(rebound.accepted,null);
  assert.equal((await f.restart()).duplicate,true);assert.equal((await f.store.read('demo')).revision,rebound.revision);
  assert.deepEqual(await readFile(f.orphan),f.orphanBytes);assert.deepEqual(await readFile(path.join(f.cwd,'.git/index')),index);assert.equal(f.git('rev-parse','HEAD'),f.currentHead);
  const opened=await f.call(['unit','stage','open','demo','implement']);assert.equal(opened.code,0,JSON.stringify(opened));assert.equal(opened.attempt,3);
  const input=JSON.parse(await readFile(opened.input,'utf8'));assert.equal(input.head,f.currentHead);assert.equal(f.git('status','--porcelain'),'');
  const current=(await f.store.read('demo')).stages.find(s=>s.name==='implement').attempts.at(-1);assert.equal(current.checkpointHead,f.currentHead);assert.equal(f.git('rev-parse',current.checkpoint+'^'),f.currentHead);
});

test('completed reopen recovery supports a later explicit descendant refresh before opening',async t=>{
  const f=await fixture(t);assert.equal((await f.restart()).code,0);const first=structuredClone((await f.store.read('demo')).stages.find(s=>s.name==='implement').attempts[0].restart);
  await writeFile(path.join(f.cwd,'base'),'newer approved base');f.git('add','base');f.git('commit','-qm','advance base again');
  assert.equal((await f.restart()).error,'STAGE_STALE');const latest=f.git('rev-parse','HEAD');
  assert.equal((await f.restart({...f.request,newHead:latest})).refreshed,true);const old=(await f.store.read('demo')).stages.find(s=>s.name==='implement').attempts[0];
  assert.deepEqual(old.restartHistory,[first]);assert.equal(old.result,'done');assert.equal(old.restart.newHead,latest);
  assert.equal((await f.call(['unit','stage','open','demo','implement'])).code,0);assert.equal(f.git('rev-parse','HEAD'),latest);
});

test('completed attempts require a newer reopen and descendant ancestry under current HEAD locks',async t=>{
  const f=await fixture(t),before=await f.store.read('demo');
  const refused=await f.restart(f.request,{command:async(binary,args,options)=>args[0]==='merge-base'?{exitCode:1,stdout:'',stderr:''}:f.adapters.command(binary,args,options)});assert.equal(refused.error,'STAGE_STALE');assert.deepEqual(await f.store.read('demo'),before);
  let blocked=false;const recovered=await f.restart(f.request,{command:async(binary,args,options)=>{if(args[0]==='merge-base'){const r=await f.adapters.command('git',['update-ref','HEAD',f.originalHead],{cwd:f.cwd});blocked=r.exitCode!==0;}return f.adapters.command(binary,args,options);}});assert.equal(recovered.code,0);assert.equal(blocked,true);assert.equal(f.git('rev-parse','HEAD'),f.currentHead);
  await f.store.update('demo',r=>({...r,reopenings:[]}));assert.equal((await f.restart()).error,'STAGE_STALE');
});

test('unsupported existing orphan JSON is rejected without overwriting bytes or changing recovery state',async t=>{
  for(const value of [null,false,0,'',[],{}])await t.test(JSON.stringify(value),async t=>{
    const f=await fixture(t),before=await f.store.read('demo'),bytes=JSON.stringify(value);await writeFile(f.orphan,bytes);
    assert.equal((await f.restart()).error,'STAGE_STALE');assert.deepEqual(await f.store.read('demo'),before);
    assert.equal((await f.call(['unit','stage','open','demo','implement'])).error,'STAGE_STALE');assert.deepEqual(await f.store.read('demo'),before);
    assert.equal(await readFile(f.orphan,'utf8'),bytes);assert.equal(f.git('rev-parse','HEAD'),f.currentHead);
  });
});
