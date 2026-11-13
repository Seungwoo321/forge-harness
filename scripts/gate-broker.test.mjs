import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateBroker,requestBrokerGate} from './lib/gate-broker.mjs';
import {executeCapturedGate,capturedGateReport} from './lib/gate-execution.mjs';
import {createAdapters} from './lib/adapters.mjs';
import {gateFingerprint} from './lib/evidence.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {runPublicUnitCli} from './lib/runtime-adapters.mjs';
import {describeRepositorySelfTests} from './verify-self-tests.mjs';

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'gate-broker-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const name of ['source','snapshots','output','output/snapshot','output/snapshot/.forge-gate-tmp','tools'])await mkdir(path.join(root,name),{recursive:true});
 return root;
}

test('AC-2 broker confines source, outputs and tools and rejects an invalid token',async t=>{
 const root=await fixture(t);let calls=0;
 const broker=await createGateBroker({root:path.join(root,'output'),outputs:[path.join(root,'output')],runtimePaths:[path.join(root,'tools')],execute:async()=>{calls++;return {exitCode:0,signal:null,stdout:'captured',stderr:''};}});
 t.after(()=>broker.close());
 const execution={sourceRoot:path.join(root,'output'),snapshotRoot:path.join(root,'output/snapshot'),temporaryRoot:path.join(root,'output/snapshot/.forge-gate-tmp'),runtimePaths:[path.join(root,'tools')],outputRoots:[path.join(root,'output/snapshot/.forge-gate-tmp')],command:['node','check.mjs'],env:{}};
 const result=await requestBrokerGate(broker.endpoint,execution);assert.equal(result.stdout,'captured');assert.equal(result.isolationBackend,'macos-sibling-sandbox-v1');
 for(const patch of [{sourceRoot:root},{snapshotRoot:root},{temporaryRoot:root},{runtimePaths:[root]},{runtimePaths:[path.join(root,'output')]},{outputRoots:[root]},{env:{BAD:'\0'}},{command:['node','\0']}]) await assert.rejects(requestBrokerGate(broker.endpoint,{...execution,...patch}),{code:'GATE_BROKER_INVALID'});
 await symlink(root,path.join(root,'output/escape'));
 await assert.rejects(requestBrokerGate(broker.endpoint,{...execution,sourceRoot:path.join(root,'output/escape')}),{code:'GATE_BROKER_INVALID'});
 await assert.rejects(requestBrokerGate(JSON.stringify({...JSON.parse(broker.endpoint),token:'wrong'}),execution),{code:'GATE_BROKER_INVALID'});
 assert.equal(calls,1);
});

test('AC-3 broker retains actual failure, signal and stdout and has no host fallback',async t=>{
 const root=await fixture(t);
 const broker=await createGateBroker({root,outputs:[root],runtimePaths:[],execute:async()=>({exitCode:9,signal:null,stdout:'not ok 1 - failed',stderr:'actual failure'})});
 const execution={sourceRoot:root,snapshotRoot:path.join(root,'output/snapshot'),temporaryRoot:path.join(root,'output/snapshot/.forge-gate-tmp'),runtimePaths:[],outputRoots:[path.join(root,'output/snapshot/.forge-gate-tmp')],command:['node','check.mjs'],env:{}};
 const result=await requestBrokerGate(broker.endpoint,execution);assert.equal(result.exitCode,9);assert.equal(result.stderr,'actual failure');
 await broker.close();await assert.rejects(requestBrokerGate(broker.endpoint,execution));
 const gate={command:['node','check.mjs'],files:[{path:'check.mjs',content:'test'}],config:{nestedIsolation:'sibling-sandbox'}};
 const report=capturedGateReport({gate,execution:{...result,inputFingerprint:gateFingerprint(gate)},reportPath:'captured.log'});
 assert.equal(report.ok,false);assert.equal(report.exit,9);assert.equal(report.execution.backend,'macos-sibling-sandbox-v1');
 assert.notEqual(gateFingerprint(gate),gateFingerprint({...gate,config:{}}));
});

async function nestedFixture(t){
 const root=await fixture(t),sourceRoot=path.join(root,'source');
 const files=[];
 for(const name of ['gate-execution','gate-snapshot','gate-broker','evidence','adapters'])files.push({path:`scripts/lib/${name}.mjs`,content:await readFile(new URL(`./lib/${name}.mjs`,import.meta.url))});
 const script=`import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {executeCapturedGate} from './scripts/lib/gate-execution.mjs';import {createAdapters} from './scripts/lib/adapters.mjs';
 const ancestorFile=process.env.FORGE_GATE_BROKER;const endpoint=JSON.parse(await readFile(ancestorFile,'utf8'));if(Object.values(process.env).some(value=>value.includes(endpoint.token)))throw Error('credential visible in process environment');process.env.BROKER_TEST_VALUE='parent-value';const root=await mkdtemp(path.join(process.env.TMPDIR,'inner-'));const sourceRoot=path.join(root,'source'),directory=path.join(root,'snapshots');await mkdir(sourceRoot);await mkdir(directory);
 const content=\`import {readFile,writeFile,link} from 'node:fs/promises';if(process.env.BROKER_TEST_VALUE!=='parent-value')throw Error('lost environment');for(const location of [\${JSON.stringify(ancestorFile)},\${JSON.stringify(path.join(sourceRoot,'input'))},\${JSON.stringify(${JSON.stringify(path.join(sourceRoot,'live'))})},\${JSON.stringify(${JSON.stringify(path.join(root,'outside'))})}]){try{await readFile(location);throw Error('exposed '+location)}catch(error){if(!['EPERM','EACCES','ENOENT'].includes(error.code))throw error;}}try{await writeFile(\${JSON.stringify(${JSON.stringify(path.join(root,'outside'))})},'changed');throw Error('write escaped')}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}try{await link(\${JSON.stringify(ancestorFile)},process.env.TMPDIR+'/stolen');throw Error('credential alias allowed')}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}console.log('INNER_ISOLATED');\`;
 await writeFile(path.join(sourceRoot,'check.mjs'),content);await writeFile(path.join(sourceRoot,'input'),'private');
 const result=await executeCapturedGate({gate:{command:[process.execPath,'check.mjs'],files:[{path:'check.mjs',content}]},sourceRoot,directory,command:createAdapters().command});
 if(result.exitCode!==0)throw Error(result.stderr);if(result.isolationBackend!=='macos-sibling-sandbox-v1')throw Error('not brokered');process.stdout.write(result.stdout);`;
 files.push({path:'entry.mjs',content:script});
 for(const file of files){await mkdir(path.dirname(path.join(sourceRoot,file.path)),{recursive:true});await writeFile(path.join(sourceRoot,file.path),file.content);}
 await writeFile(path.join(sourceRoot,'live'),'not captured');await writeFile(path.join(root,'outside'),'outside');
 return {gate:{command:[process.execPath,'entry.mjs'],files,config:{nestedIsolation:'sibling-sandbox'}},sourceRoot,directory:path.join(root,'snapshots'),root};
}

test('AC-1 AC-2 real macOS sibling sandbox runs isolated inner gates and blocks live and outside trees',{skip:process.platform!=='darwin'},async t=>{
 const fixture=await nestedFixture(t),{root}=fixture;
 const result=await executeCapturedGate({...fixture,command:createAdapters().command});
 assert.equal(result.exitCode,0,result.stderr);assert.equal(result.stdout,'INNER_ISOLATED\n');assert.equal(result.isolationBackend,process.env.FORGE_GATE_BROKER ? 'macos-sibling-sandbox-v1' : 'macos-sibling-sandbox-host-v1');assert.equal(await readFile(path.join(root,'outside'),'utf8'),'outside');
});


test('AC-1 AC-3 public acceptance preserves failed records and records real brokered evidence',{skip:process.platform!=='darwin'},async t=>{
 const {gate,sourceRoot,root}=await nestedFixture(t);
 gate.command=[process.execPath,'--input-type=module','-e',`await import('./entry.mjs');console.log('TAP version 13\\n1..1\\nok 1 - AC-1 nested isolation');`];
 gate.format='tap';gate.acPattern='AC-1';
 const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot);
 const failed={gate:'tests',status:'failed',exit:71,failureClass:'environment',fingerprint:gateFingerprint({...gate,config:{}}),covers:[]};
 await store.create({schema:'harness.unit/1',unit:'sample',kind:'impl',state:'SelfGated',request:'nested test',policy:{goal:{class:'task'},review:{mode:'none',by:'session',triggers:[]},delivery:'none'},acceptance:[{id:'AC-1',text:'nested isolation works',status:'open'}],evidence:[failed],openDecisions:[],findings:[],failures:[],stages:[]});
 const definition={...gate,files:gate.files.map(file=>({...file,content:String(file.content)}))};
 await writeFile(path.join(sourceRoot,'provider.mjs'),`export function createRuntimeAdapters(){return {git:{async inspectUnit(){return {head:'head',contentFingerprint:'content'}}},gates:{async describe(id){return {...${JSON.stringify(definition)},id}}}}}`);
 const output=await runPublicUnitCli(['unit','accept','sample','--state-root',stateRoot,'--project-root',sourceRoot,'--adapters','provider.mjs'],{cwd:sourceRoot});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.code,0,JSON.stringify(result));
 const record=await store.read('sample');assert.deepEqual(record.evidence[0],failed);assert.equal(record.state,'Accepted');
 for(const evidence of record.evidence.slice(1)){assert.equal(evidence.status,'passed');assert.match(evidence.execution.backend,/^macos-sibling-sandbox/);assert.match(await readFile(evidence.report,'utf8'),/INNER_ISOLATED/);}
});

test('AC-2 child capabilities cannot use ancestor outputs or survive their execution',async t=>{
 const root=await fixture(t),snapshotRoot=path.join(root,'output/snapshot'),temporaryRoot=path.join(snapshotRoot,'.forge-gate-tmp');
 for(const name of ['source','child','.forge-gate-tmp'])await mkdir(path.join(temporaryRoot,name));
 await mkdir(path.join(temporaryRoot,'child/.forge-gate-tmp'));
 let childEndpoint;
 const parent={sourceRoot:path.join(root,'output'),snapshotRoot,temporaryRoot,runtimePaths:[],outputRoots:[temporaryRoot],command:['parent'],env:{}};
 const child={...parent,sourceRoot:path.join(temporaryRoot,'source'),snapshotRoot:path.join(temporaryRoot,'child'),temporaryRoot:path.join(temporaryRoot,'child/.forge-gate-tmp'),outputRoots:[path.join(temporaryRoot,'child/.forge-gate-tmp')],command:['child']};
 const broker=await createGateBroker({root,outputs:[path.join(root,'output')],runtimePaths:[],execute:async(input,endpoint)=>{
   if(input.command[0]==='parent'){
     childEndpoint=endpoint;
     await assert.rejects(requestBrokerGate(endpoint,{...child,sourceRoot:root}),{code:'GATE_BROKER_INVALID'});
     await assert.rejects(requestBrokerGate(endpoint,{...child,snapshotRoot:path.join(root,'output')}),{code:'GATE_BROKER_INVALID'});
     assert.equal((await requestBrokerGate(endpoint,child)).stdout,'child');
   }
   return {exitCode:0,signal:null,stdout:input.command[0],stderr:''};
 }});
 t.after(()=>broker.close());
 assert.equal((await requestBrokerGate(broker.endpoint,parent)).stdout,'parent');
 await assert.rejects(requestBrokerGate(childEndpoint,child),{code:'GATE_BROKER_INVALID'});
});

test('AC-2 broker shutdown drains accepted execution before returning',async t=>{
 const root=await fixture(t);let started,release;
 const ready=new Promise(resolve=>started=resolve),finish=new Promise(resolve=>release=resolve);
 const broker=await createGateBroker({root,outputs:[root],runtimePaths:[],execute:async()=>{started();await finish;return {exitCode:null,signal:'SIGTERM',stdout:'partial',stderr:'terminated'};}});
 const request=requestBrokerGate(broker.endpoint,{sourceRoot:root,snapshotRoot:path.join(root,'output/snapshot'),temporaryRoot:path.join(root,'output/snapshot/.forge-gate-tmp'),runtimePaths:[],outputRoots:[path.join(root,'output/snapshot/.forge-gate-tmp')],command:['child'],env:{}});
 await ready;let closed=false;const closing=broker.close().then(()=>closed=true);
 assert.equal(closed,false);release();assert.equal((await request).signal,'SIGTERM');await closing;assert.equal(closed,true);
});


test('AC-4 self-test capture includes tracked and new tests and excludes local artifacts',async t=>{
 const root=await fixture(t),command=createAdapters().command;
 const init=await command('git',['init','--quiet'],{cwd:root});assert.equal(init.exitCode,0,init.stderr);
 const {packageManager}=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
 await writeFile(path.join(root,'package.json'),JSON.stringify({packageManager}));
 await writeFile(path.join(root,'.gitignore'),'.local/\n');
 await mkdir(path.join(root,'.local'));await writeFile(path.join(root,'.local/private'),'excluded');
 await mkdir(path.join(root,'scripts'));await writeFile(path.join(root,'scripts/existing.test.mjs'),'existing');
 const added=await command('git',['add','package.json','.gitignore','scripts/existing.test.mjs'],{cwd:root});assert.equal(added.exitCode,0,added.stderr);
 await writeFile(path.join(root,'scripts/new.test.mjs'),'new',{mode:0o755});
 const gate=await describeRepositorySelfTests({cwd:root,command});
 assert.deepEqual(gate.files.map(file=>file.path),['.gitignore','package.json','scripts/existing.test.mjs','scripts/new.test.mjs']);
 assert.equal(gate.files.find(file=>file.path==='scripts/new.test.mjs').mode,'100755');
 assert.equal(gate.config.nestedIsolation,'sibling-sandbox');
 assert.equal(gate.command[2],'--inside');assert.equal(gate.toolVersions.pnpm,packageManager.split('@')[1]);
});
