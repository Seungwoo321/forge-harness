import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {runPublicUnitCli} from './lib/runtime-adapters.mjs';
import {gateFingerprint} from './lib/evidence.mjs';

test('AC-1 public acceptance records copied read-only outputs as isolated command evidence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-acceptance-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a';
 const script='import {cp} from "node:fs/promises";await cp("fixture","output/copied",{recursive:true});console.log("TAP version 13\\n1..1\\nok 1 - AC-1 isolated")';
 await writeFile(path.join(root,'gate.mjs'),script);
 await mkdir(path.join(root,'fixture'));await writeFile(path.join(root,'fixture/input'),'captured');
 const gate={command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:script},{path:'fixture/input',content:'captured'}],outputDirectories:['output'],format:'tap',acPattern:'AC-1'};
 const ids=['typecheck','lint','tests','build','acceptance-coverage'];
 const old=ids.map(id=>({gate:id,fingerprint:gateFingerprint(gate),status:'passed',exit:0,covers:['AC-1']}));
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},
   acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:old,openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')},{path:'fixture/input',content:await readFile(path.join(cwd,'fixture/input'),'utf8')}],outputDirectories:['output'],format:'tap',acPattern:'AC-1',reportPath:'gate.tap'}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.code,0,JSON.stringify(result));
 const record=await store.read(unit);assert.deepEqual(record.evidence.slice(0,old.length),old);
 const fresh=record.evidence.slice(old.length);assert.equal(fresh.length,ids.length);
 for(const evidence of fresh){assert.equal(evidence.execution.kind,'isolated-snapshot-v1');assert.equal(evidence.execution.fingerprint,evidence.fingerprint);assert.match(await readFile(evidence.report,'utf8'),/AC-1 isolated/);}
});


for (const boundary of ['snapshot','outer','report','persist']) test('AC-2 public acceptance retains diagnostics after '+boundary+' cleanup failure',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-cleanup-receipt-'));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a';
 const script="console.log(process.cwd());console.error('original diagnostic');process.exitCode=7;";
 await writeFile(path.join(root,'gate.mjs'),script);
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},
 acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:[],openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')}],format:'exec'}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const originalRmdir=fs.rmdir,originalOpen=fs.open;
 t.mock.method(fs,'rmdir',async directory=>{
  const match=['outer','persist'].includes(boundary)?path.basename(directory).startsWith('forge-gate-'):path.basename(directory).startsWith('gate-');
  if(match)throw Object.assign(new Error('injected cleanup denial'),{code:'EACCES'});return originalRmdir(directory);
 });
 if(['report','persist'].includes(boundary))t.mock.method(fs,'open',async(file,...args)=>{if(String(file).includes('/gate-reports/'))throw Object.assign(new Error('injected report storage failure'),{code:'ENOSPC'});return originalOpen(file,...args);});
 syncBuiltinESMExports();let snapshot;
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();if(snapshot)await rm(path.dirname(snapshot),{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
 snapshot=result.execution?.stdout.trim();assert.ok(snapshot,JSON.stringify(result));
 assert.notEqual(result.code,0);assert.equal(result.execution.exitCode,7);assert.equal(result.execution.stderr,'original diagnostic\n');assert.equal(result.error,boundary==='persist'?'ENOSPC':'EACCES');
 if(boundary==='report'){assert.equal(result.reportError.code,'ENOSPC');assert.equal(result.reportPath,undefined);}
 else if(boundary==='persist'){assert.equal(result.cleanupError.code,'EACCES');assert.equal(result.reportPath,undefined);}
 else assert.equal(await readFile(result.reportPath,'utf8'),result.execution.stdout);
 const record=await store.read(unit);assert.equal(record.state,'SelfGated');assert.equal(record.evidence.some(item=>item.status==='passed'),false);
});

for (const boundary of ['validation','report-format']) test('AC-2 '+boundary+' failure with successful cleanup persists completed output',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-validation-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a';
 const script=`import {chmod,appendFile} from 'node:fs/promises';console.log(process.cwd());console.error('validation diagnostic');${boundary==='validation'?"await chmod('gate.mjs',0o600);await appendFile('gate.mjs','\\n');":''}process.exitCode=7;`;
 await writeFile(path.join(root,'gate.mjs'),script);
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:[],openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')}],format:'exec'${boundary==='report-format'?",resultFormat:'unsupported'":''}}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
 assert.equal(result.error,'GATE_SNAPSHOT_INVALID');assert.equal(result.execution?.exitCode,7,JSON.stringify(result));
 assert.equal(result.execution.stderr,'validation diagnostic\n');assert.equal(result.execution.signal,null);
 assert.equal(await readFile(result.reportPath,'utf8'),result.execution.stdout);
 await assert.rejects(fs.stat(result.execution.stdout.trim()),{code:'ENOENT'});
 assert.equal(result.cleanupError,undefined);assert.equal(result.reportError,undefined);
 assert.equal((await store.read(unit)).evidence.some(x=>x.status==='passed'),false);
});

for (const termination of [7,'SIGTERM','SIGINT']) test('AC-2 ordinary result persists stderr and original termination '+termination,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-termination-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a',stderr='termination diagnostic\n'+'x'.repeat(16384)+'\n';
 const finish=typeof termination==='string'?`process.kill(process.pid,${JSON.stringify(termination)})`:`process.exitCode=${termination}`;
 const script=`process.stdout.write('parser stdout\\n',()=>process.stderr.write(${JSON.stringify(stderr)},()=>{${finish}}));`;
 await writeFile(path.join(root,'gate.mjs'),script);
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:[],openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')}],format:'exec'}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.notEqual(result.code,0);
 const record=await store.read(unit);assert.equal(record.state,'SelfGated');assert.ok(record.evidence.length);
 for(const evidence of record.evidence){
  assert.equal(evidence.status,'failed');assert.equal(evidence.exit,typeof termination==='string'?2:7);
  assert.equal(await readFile(evidence.report,'utf8'),'parser stdout\n');
  assert.equal(evidence.execution.signal,typeof termination==='string'?termination:null);
  assert.equal(evidence.execution.exitCode,typeof termination==='string'?null:7);
  const diagnosticBytes=await readFile(evidence.execution.diagnostics.report,'utf8'),diagnostic=JSON.parse(diagnosticBytes);
  assert.equal(diagnostic.stderr,stderr);assert.equal(diagnostic.signal,evidence.execution.signal);assert.equal(diagnostic.exitCode,evidence.execution.exitCode);
  assert.equal(evidence.execution.diagnostics.digest,'sha256:'+(await import('node:crypto')).createHash('sha256').update(diagnosticBytes).digest('hex'));
  assert.ok(JSON.stringify(evidence).length<4096,'large stderr belongs in durable artifact, not canonical inline metadata');
 }
});

test('AC-2 diagnostic storage failure retains stdout receipt and cannot record a passing gate',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gate-diagnostic-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),unit='unit-a';
 await writeFile(path.join(root,'gate.mjs'),"console.log('successful stdout');console.error('diagnostic before storage failure');");
 await store.create({schema:'harness.unit/1',unit,kind:'impl',state:'SelfGated',request:'work',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},acceptance:[{id:'AC-1',text:'works',status:'open'}],evidence:[],openDecisions:[],findings:[],failures:[],stages:[]});
 const provider=`import {readFile} from 'node:fs/promises';import path from 'node:path';export function createRuntimeAdapters({cwd}){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(path.join(cwd,'gate.mjs'),'utf8')}],format:'exec'}}}}}`;
 await writeFile(path.join(root,'provider.mjs'),provider);
 const open=fs.open;let reportCreates=0;
 t.mock.method(fs,'open',async(file,...args)=>{
  if(String(file).includes('/gate-reports/')&&args[0]==='wx'&&++reportCreates===2)throw Object.assign(new Error('diagnostic storage full'),{code:'ENOSPC'});
  return open(file,...args);
 });syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const output=await runPublicUnitCli(['unit','accept',unit,'--state-root',stateRoot,'--project-root',root,'--adapters','provider.mjs'],{cwd:root});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
 assert.equal(result.error,'ENOSPC');assert.equal(result.execution.exitCode,0);assert.equal(result.execution.stderr,'diagnostic before storage failure\n');
 assert.equal(await readFile(result.reportPath,'utf8'),'successful stdout\n');assert.equal(reportCreates,2);
 assert.equal((await store.read(unit)).evidence.some(x=>x.status==='passed'),false);
});
