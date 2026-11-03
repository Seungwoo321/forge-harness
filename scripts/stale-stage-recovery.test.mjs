import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const contractsDir = fileURLToPath(new URL('../skills', import.meta.url));
const result = output => JSON.parse(output.split('\n').at(-1).slice(7));

test('a stale implementation checkpoint is retired without losing work or earlier history', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'stale-stage-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'source'), 'base'); git('add', 'source'); git('commit', '-qm', 'base');
  const stateRoot = path.join(cwd, '.git', 'work-state'), store = createUnitStateStore(stateRoot);
  await store.create({ schema:'harness.unit/1', unit:'demo', kind:'impl', state:'Implementing', request:'work',
    policy:{goal:{class:'task'}}, scopePaths:['source'], acceptance:[{id:'AC-1',text:'works',status:'open'}],
    head:git('rev-parse','HEAD'), contentFingerprint:'previous-review', stages:[], evidence:[], findings:[], assumptions:[], openDecisions:[], canon:[], feedback:[] });
  const adapters = createAdapters({ repositoryRoot:cwd });
  const call = async args => result(await runUnitCli(args, { cwd, stateRoot, contractsDir, adapters }));
  const opened = await call(['unit','stage','open','demo','implement']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const original = (await store.read('demo')).stages[0].attempts[0];
  await writeFile(path.join(cwd,'source'), 'integrated'); git('add','source'); git('commit','-qm','integrate');
  await writeFile(path.join(cwd,'source'), 'preserved work');
  const request = { attempt:original.n, inputDigest:original.inputDigest, checkpointHead:original.checkpointHead, newHead:git('rev-parse','HEAD') };
  const requestPath = path.join(cwd,'.git','restart.json');
  await writeFile(requestPath, JSON.stringify({...request,newHead:original.checkpointHead}));
  assert.equal((await call(['unit','stage','restart','demo','implement','--request',requestPath])).error,'STAGE_STALE');
  assert.equal((await store.read('demo')).stages[0].attempts[0].endedAt,null);
  await writeFile(requestPath, JSON.stringify(request));
  const branch = git('symbolic-ref','HEAD');
  const linked = await mkdtemp(path.join(os.tmpdir(),'stale-stage-linked-'));
  t.after(() => rm(linked,{recursive:true,force:true}));
  git('worktree','add','--detach',linked,request.newHead);
  git('branch','other',request.newHead);
  git('symbolic-ref','refs/heads/alias',branch);
  git('symbolic-ref','HEAD','refs/heads/alias');
  execFileSync('git',['symbolic-ref','refs/heads/alias','refs/heads/other'],{cwd:linked});
  assert.equal((await call(['unit','stage','restart','demo','implement','--request',requestPath])).error,'STAGE_STALE');
  assert.equal((await store.read('demo')).stages[0].attempts[0].endedAt,null);
  git('symbolic-ref','HEAD',branch);
  git('worktree','remove',linked);
  const unrelated = { ...adapters, command: async (binary, args, options) => args[0] === 'merge-base'
    ? {exitCode:1,stdout:'',stderr:''} : adapters.command(binary,args,options) };
  assert.equal(result(await runUnitCli(['unit','stage','restart','demo','implement','--request',requestPath], { cwd, stateRoot, contractsDir, adapters:unrelated })).error,'STAGE_STALE');
  let blocked = false, concurrent;
  const racing = { ...adapters, command: async (binary, args, options) => {
    if (args[0] === 'merge-base') {
      const competing = await adapters.command('git',['update-ref','HEAD',original.checkpointHead],{cwd});
      blocked = competing.exitCode !== 0;
      concurrent = await call(['unit','stage','restart','demo','implement','--request',requestPath]);
    }
    return adapters.command(binary,args,options);
  } };
  const restarted = result(await runUnitCli(['unit','stage','restart','demo','implement','--request',requestPath], { cwd, stateRoot, contractsDir, adapters:racing }));
  assert.equal(restarted.code,0);assert.notEqual(concurrent.code,0);
  assert.equal(blocked,true);
  const retired = (await store.read('demo')).stages[0].attempts[0];
  assert.equal(retired.result,'superseded'); assert.equal(retired.checkpoint,original.checkpoint);
  assert.equal(retired.inputDigest,original.inputDigest); assert.equal(retired.restart.newHead,request.newHead);
  assert.equal(await readFile(path.join(cwd,'source'),'utf8'),'preserved work');
  await writeFile(path.join(cwd,'additional'),'later commit');git('add','additional');git('commit','-qm','later integration');
  assert.equal((await call(['unit','stage','open','demo','implement'])).error,'CHECKPOINT_STALE');
  const orphan = path.join(stateRoot,'units','demo','stages','implement.2.input.json');
  const orphanBytes = await readFile(orphan);
  request.newHead=git('rev-parse','HEAD');await writeFile(requestPath,JSON.stringify(request));
  assert.equal((await call(['unit','stage','restart','demo','implement','--request',requestPath])).refreshed,true);
  const revision = (await store.read('demo')).revision;
  assert.equal((await call(['unit','stage','restart','demo','implement','--request',requestPath])).duplicate,true);
  assert.equal((await store.read('demo')).revision,revision);
  assert.equal((await store.read('demo')).stages[0].attempts[0].restartHistory[0].newHead,retired.restart.newHead);
  assert.deepEqual(await readFile(orphan),orphanBytes);
  const next = await call(['unit','stage','open','demo','implement']);
  assert.equal(next.code,0,JSON.stringify(next)); assert.equal(next.attempt,3);
  const input = JSON.parse(await readFile(next.input,'utf8'));
  const output = path.join(cwd,'.git','output.json');
  await writeFile(output,JSON.stringify({inputDigest:input.inputDigest,attempt:input.attempt,submissionId:'retry',status:'done',summary:'resumed',changedPaths:['source'],coverage:[],assumptions:[],openDecisions:[]}));
  assert.equal((await call(['unit','stage','submit','demo','implement','--output',output])).state,'SelfGated');
  assert.equal(await readFile(path.join(cwd,'source'),'utf8'),'preserved work');
});
