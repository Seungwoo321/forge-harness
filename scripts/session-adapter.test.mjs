import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntimeAdapters} from './session-adapter.mjs';

test('packaged adapter reads the exact owner from the durable request or finalization record',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'session-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'units','u'),{recursive:true});
  const owner={runtime:'cmux',sessionId:'s',incarnationId:'i',cwd:root,worker:{executable:'codex'}};
  await writeFile(path.join(root,'units','u','unit.json'),JSON.stringify({sessionFinalization:{owner}}));
  const args={cwd:root,adapters:{command:async()=>{}},options:{'state-root':root},argv:['unit','finalize','u']};
  assert.equal(typeof (await createRuntimeAdapters(args)).sessionRunner.observe,'function');
  await writeFile(path.join(root,'request.json'),JSON.stringify({parentRuntime:{...owner,workerExecutable:'shell'}}));
  await assert.rejects(createRuntimeAdapters({...args,options:{...args.options,request:'request.json'}}),/worker executable/);
});
