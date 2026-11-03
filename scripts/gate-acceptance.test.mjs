import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {runPublicUnitCli} from './lib/runtime-adapters.mjs';
import {gateFingerprint} from './lib/evidence.mjs';

test('public acceptance replaces legacy passing evidence with isolated command evidence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-acceptance-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a';
 const script='console.log("TAP version 13\\n1..1\\nok 1 - AC-1 isolated")';
 await writeFile(path.join(root,'gate.mjs'),script);
 const gate={command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:script}],format:'tap',acPattern:'AC-1'};
 const ids=['typecheck','lint','tests','build','acceptance-coverage'];
 const old=ids.map(id=>({gate:id,fingerprint:gateFingerprint(gate),status:'passed',exit:0,covers:['AC-1']}));
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},
   acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:old,openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')}],format:'tap',acPattern:'AC-1',reportPath:'gate.tap'}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.code,0,JSON.stringify(result));
 const record=await store.read(unit);assert.deepEqual(record.evidence.slice(0,old.length),old);
 const fresh=record.evidence.slice(old.length);assert.equal(fresh.length,ids.length);
 for(const evidence of fresh){assert.equal(evidence.execution.kind,'isolated-snapshot-v1');assert.equal(evidence.execution.fingerprint,evidence.fingerprint);assert.match(await readFile(evidence.report,'utf8'),/AC-1 isolated/);}
});
