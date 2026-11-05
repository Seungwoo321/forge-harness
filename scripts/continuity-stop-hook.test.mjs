import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
