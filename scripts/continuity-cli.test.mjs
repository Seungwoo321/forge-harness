import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
test('public goal registration checks its source and binds an eligible unit', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'goal-cli-')); t.after(() => rm(root,{recursive:true,force:true}));
  const file = path.join(root,'goal.md'); const bytes = 'Goal: deliver both units\n'; await writeFile(file,bytes);
  const source = {path:file,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
  const goal = {id:'g1',objective:'deliver',criteria:['verified'],remaining:['u1'],status:'active'};
  const policy = {runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']};
  await mkdir(path.join(root,'state'), {recursive:true});
  await writeFile(path.join(root,'state','policy.json'),JSON.stringify({goal:{class:'task'},session:policy}));
  const request = path.join(root,'goal.json'); await writeFile(request,JSON.stringify({goal,source}));
  const run = (...args) => spawnSync(process.execPath,[cli,...args,'--state-root',path.join(root,'state'),'--project-root',root],{cwd:root,encoding:'utf8'});
  assert.equal(run('goal','create','g1','--request',request).status,0);
  const unit = path.join(root,'unit.json'); await writeFile(unit,JSON.stringify({kind:'impl',goalId:'g1',request:{text:'work',userInputRef:'user'}}));
  assert.equal(run('unit','start','u1','--request',unit,'--non-interactive').status,0);
  assert.notEqual(run('unit','start','u2','--request',unit,'--non-interactive').status,0);
  await writeFile(file,'changed');
  assert.notEqual(run('goal','create','g1','--request',request).status,0);
});
