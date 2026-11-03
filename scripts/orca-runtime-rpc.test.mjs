import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createOrcaRuntimeRpc} from './lib/orca-runtime-rpc.mjs';

test('Orca process inspection discovers the runtime client shipped beside the selected CLI',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'orca-rpc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=path.join(root,'bin','orca'), module=path.join(root,'app.asar.unpacked','out','cli','runtime-client.js');
  await mkdir(path.dirname(binary),{recursive:true});await writeFile(binary,'');
  await mkdir(path.dirname(module),{recursive:true});
  await writeFile(module,'exports.RuntimeClient=class { async call(method,params) { return {method,params}; } };');
  const rpc=createOrcaRuntimeRpc({cwd:root,command:async()=>({exitCode:0,stdout:binary})});
  assert.deepEqual(await rpc('terminal.inspectProcess',{terminal:'t'}),{method:'terminal.inspectProcess',params:{terminal:'t'}});
  await assert.rejects(rpc('terminal.close',{}),/unsupported/);
});
