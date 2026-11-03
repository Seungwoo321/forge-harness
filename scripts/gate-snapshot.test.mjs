import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateSnapshot} from './lib/gate-snapshot.mjs';
import {capturedGateReport,executeCapturedGate} from './lib/gate-execution.mjs';
import {gateFingerprint} from './lib/evidence.mjs';
import {createAdapters} from './lib/adapters.mjs';

test('snapshot holds captured input bytes in a private read-only tree',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-snapshot-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=Buffer.from('original');
 const snapshot=await createGateSnapshot({directory,files:[{path:'src/check.mjs',content:source,mode:'100755'}]});
 source.fill(0);
 assert.equal(await readFile(path.join(snapshot.root,'src/check.mjs'),'utf8'),'original');
 assert.equal((await stat(path.join(snapshot.root,'src/check.mjs'))).mode & 0o777,0o500);
 assert.equal((await stat(snapshot.root)).mode & 0o777,0o500);
 await snapshot.assertUnchanged();
 await snapshot.cleanup();await assert.rejects(stat(snapshot.root),{code:'ENOENT'});
});

test('restoring changed bytes does not make a modified snapshot valid',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-snapshot-'));
 const snapshot=await createGateSnapshot({directory,files:[{path:'input',content:'original'}]});
 t.after(async()=>{await snapshot.cleanup();await rm(directory,{recursive:true,force:true});});
 const file=path.join(snapshot.root,'input');await chmod(file,0o600);await writeFile(file,'modified');await writeFile(file,'original');await chmod(file,0o400);
 await assert.rejects(snapshot.assertUnchanged(),{code:'GATE_SNAPSHOT_INVALID'});
});

test('snapshot refuses traversal, absolute and ambiguous input names',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-snapshot-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of ['../escape','/absolute','a/../escape','a//b','a\\b']) await assert.rejects(createGateSnapshot({directory,files:[{path:name,content:'x'}]}),{code:'GATE_SNAPSHOT_INVALID'});
 await assert.rejects(createGateSnapshot({directory,files:[{path:'same',content:'a'},{path:'same',content:'b'}]}),{code:'GATE_SNAPSHOT_INVALID'});
 await assert.rejects(createGateSnapshot({directory,files:[{path:'link',content:'../../outside',mode:'120000'}]}),{code:'GATE_SNAPSHOT_INVALID'});
 await assert.rejects(createGateSnapshot({directory,files:[{path:'link',content:'target',mode:'120000'},{path:'link/file',content:'x'}]}),{code:'GATE_SNAPSHOT_INVALID'});
 await assert.rejects(createGateSnapshot({directory,files:[{path:'node_modules/pkg.js',content:'x'}],outputDirectories:['node_modules']}),{code:'GATE_SNAPSHOT_INVALID'});
});

test('captured internal symbolic links retain their target without exposing the live tree',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-links-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);await mkdir(path.join(sourceRoot,'real'));
 const script='process.stdout.write(await (await import("node:fs/promises")).readFile("link.mjs", "utf8"))';
 const files=[{path:'check.mjs',content:script},{path:'link.mjs',content:'real/value.mjs',mode:'120000'},{path:'real/value.mjs',content:'dependency'}];
 await writeFile(path.join(sourceRoot,'check.mjs'),script);await writeFile(path.join(sourceRoot,'real/value.mjs'),'dependency');await symlink('real/value.mjs',path.join(sourceRoot,'link.mjs'));
 const result=await executeCapturedGate({gate:{id:'check',command:[process.execPath,'check.mjs'],files},directory:snapshots,sourceRoot,command:createAdapters().command});
 assert.equal(result.exitCode,0);assert.equal(result.stdout,'dependency');
});

test('pnpm can run a declared project script from the isolated input tree',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-pnpm-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 const command=createAdapters().command, version=(await command('pnpm',['--version'],{cwd:sourceRoot})).stdout.trim();
 const files=[{path:'package.json',content:JSON.stringify({name:'snapshot-check',private:true,packageManager:`pnpm@${version}`,scripts:{check:'node check.mjs'}})},{path:'check.mjs',content:'await (await import("node:fs/promises")).writeFile("node_modules/generated","ok");console.log("PNPM_SNAPSHOT_OK")'}];
 for(const file of files)await writeFile(path.join(sourceRoot,file.path),file.content);
 const lock=await command('pnpm',['install','--lockfile-only','--ignore-scripts','--offline'],{cwd:sourceRoot});assert.equal(lock.exitCode,0,lock.stderr);
 files.push({path:'pnpm-lock.yaml',content:await readFile(path.join(sourceRoot,'pnpm-lock.yaml'),'utf8')});
 const result=await executeCapturedGate({gate:{id:'check',command:['pnpm','run','check'],files,outputDirectories:['node_modules']},directory:snapshots,sourceRoot,command});
 assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/PNPM_SNAPSHOT_OK/);
});

test('the control plane runs the declared command in the captured tree',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-exec-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source');await mkdir(sourceRoot);
 const snapshots=path.join(directory,'snapshots');await mkdir(snapshots);
 const gate={id:'check',command:[process.execPath,'check.mjs'],files:[{path:'check.mjs',content:'process.stdout.write(await (await import("node:fs/promises")).readFile("input", "utf8"))'},{path:'input',content:'captured'}]};
 for(const file of gate.files)await writeFile(path.join(sourceRoot,file.path),file.content);
 const result=await executeCapturedGate({gate,directory:snapshots,sourceRoot,command:createAdapters().command});
 assert.equal(result.exitCode,0);assert.equal(result.stdout,'captured');assert.match(result.inputFingerprint,/^sha256:/);
 await writeFile(path.join(sourceRoot,'input'),'changed');
 await assert.rejects(executeCapturedGate({gate,directory:snapshots,sourceRoot,command:createAdapters().command}),{code:'GATE_SNAPSHOT_INVALID'});
});

test('snapshot command cannot read the mutable live source tree',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-isolation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 const source=path.join(sourceRoot,'input');await writeFile(source,'live');
 const script=`import {readFile} from 'node:fs/promises'; try { await readFile(${JSON.stringify(source)}); process.exit(9); } catch (error) { process.stdout.write(error.code); }`;
 const gate={id:'check',command:[process.execPath,'check.mjs'],files:[{path:'check.mjs',content:script}]};
 await writeFile(path.join(sourceRoot,'check.mjs'),script);
 const result=await executeCapturedGate({gate,directory:snapshots,sourceRoot,command:createAdapters().command});
 assert.equal(result.exitCode,0);assert.match(result.stdout,/^(EACCES|EPERM|ENOENT)$/);
});

test('a live input changed and restored during execution cannot alter captured input',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots'),coord=path.join(directory,'coord');
 await mkdir(sourceRoot);await mkdir(snapshots);await mkdir(coord);
 const script=`import {access,readFile,writeFile} from 'node:fs/promises';const dir=${JSON.stringify(coord)};async function wait(name){for(let i=0;i<500;i++){try{await access(dir+'/'+name);return}catch{}await new Promise(r=>setTimeout(r,10))}throw Error('timeout')}await writeFile(dir+'/ready','');await wait('read');const value=await readFile('input','utf8');await writeFile(dir+'/read-done','');await wait('finish');process.stdout.write(value);`;
 const files=[{path:'check.mjs',content:script},{path:'input',content:'original'}];
 for(const file of files)await writeFile(path.join(sourceRoot,file.path),file.content);
 const wait=async name=>{for(let i=0;i<500;i++){try{await readFile(path.join(coord,name));return}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`timed out waiting for ${name}`);};
 const running=executeCapturedGate({gate:{id:'check',command:[process.execPath,'check.mjs'],files},directory:snapshots,sourceRoot,command:createAdapters().command});
 await wait('ready');await writeFile(path.join(sourceRoot,'input'),'modified');await writeFile(path.join(coord,'read'),'');
 await wait('read-done');await writeFile(path.join(sourceRoot,'input'),'original');await writeFile(path.join(coord,'finish'),'');
 const result=await running;assert.equal(result.exitCode,0);assert.equal(result.stdout,'original');
});

test('captured reports use the actual exit and the fingerprinted output contract',()=>{
 const gate={id:'coverage',command:['node','check.mjs'],files:[{path:'check.mjs',content:'source'}],format:'exec',resultFormat:'json'};
 const execution={inputFingerprint:gateFingerprint(gate),exitCode:1,stdout:'{"ok":true,"covers":["AC-1"]}'};
 const report=capturedGateReport({gate,execution,reportPath:'report.json'});
 assert.equal(report.exit,1);assert.equal(report.ok,false);assert.deepEqual(report.covers,[]);
 const passed=capturedGateReport({gate,execution:{...execution,exitCode:0},reportPath:'report.json'});
 assert.equal(passed.ok,true);assert.deepEqual(passed.covers,['AC-1']);
 assert.throws(()=>capturedGateReport({gate,execution:{...execution,inputFingerprint:'sha256:wrong'},reportPath:'report.json'}),{code:'GATE_SNAPSHOT_INVALID'});
 const malformed=capturedGateReport({gate,execution:{...execution,exitCode:0,stdout:'invalid'},reportPath:'report.json'});
 assert.equal(malformed.exit,1);assert.equal(malformed.failureClass,'harness');assert.deepEqual(malformed.covers,[]);
});
