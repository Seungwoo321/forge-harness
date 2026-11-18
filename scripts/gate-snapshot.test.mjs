import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {chmod,link,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
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
 const launcher=await realpath((await command('which',['pnpm'],{cwd:sourceRoot})).stdout.trim());
 const manager=(await command('pnpm',['exec','node','-p','process.env.npm_execpath'],{cwd:sourceRoot})).stdout.trim().split('\n').at(-1);
 const runtimePaths=[path.dirname(path.dirname(launcher)),path.dirname(path.dirname(path.dirname(path.dirname(manager))))];
 const result=await executeCapturedGate({gate:{id:'check',command:['pnpm','run','check'],files,config:{runtimePaths},outputDirectories:['node_modules']},directory:snapshots,sourceRoot,command});
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

test('a macOS snapshot command can securely traverse its own root ancestors but not read siblings',{skip:process.platform!=='darwin'},async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-ancestors-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 const secret=path.join(directory,'secret');await writeFile(secret,'sibling');
 const script=`import {openSync,closeSync,readFileSync,constants} from 'node:fs'; import path from 'node:path';
const parts=process.cwd().split(path.sep).filter(Boolean);let dir='/';
for(const part of ['',...parts]){dir=path.join(dir,part);try{closeSync(openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW));}catch(error){process.stdout.write(JSON.stringify({traverse:error.code,dir}));process.exit(0);}}
try{readFileSync(${JSON.stringify(secret)});process.stdout.write('read');}catch(error){process.stdout.write(error.code);}`;
 const gate={id:'check',command:[process.execPath,'check.mjs'],files:[{path:'check.mjs',content:script}]};
 await writeFile(path.join(sourceRoot,'check.mjs'),script);
 const result=await executeCapturedGate({gate,directory:snapshots,sourceRoot,command:createAdapters().command});
 assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/^(EACCES|EPERM)$/);
});

test('a live input changed and restored during execution cannot alter captured input',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');let coord;
 await mkdir(sourceRoot);await mkdir(snapshots);
 const script=`import {access,readFile,writeFile} from 'node:fs/promises';const dir=process.env.TMPDIR;async function wait(name){for(let i=0;i<3000;i++){try{await access(dir+'/'+name);return}catch{}await new Promise(r=>setTimeout(r,10))}throw Error('timeout')}await writeFile(dir+'/ready','');await wait('read');const value=await readFile('input','utf8');await writeFile(dir+'/read-done','');await wait('finish');process.stdout.write(value);`;
 const files=[{path:'check.mjs',content:script},{path:'input',content:'original'}];
 for(const file of files)await writeFile(path.join(sourceRoot,file.path),file.content);
 const wait=async name=>{for(let i=0;i<3000;i++){if(coord){try{await readFile(path.join(coord,name));return}catch(error){if(error.code!=='ENOENT')throw error;}}await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`timed out waiting for ${name}`);};
 const command=createAdapters().command;
 const running=executeCapturedGate({gate:{id:'check',command:[process.execPath,'check.mjs'],files},directory:snapshots,sourceRoot,command:(binary,args,options)=>{coord=options.env.TMPDIR;return command(binary,args,options);}});
 await wait('ready');await writeFile(path.join(sourceRoot,'input'),'modified');await writeFile(path.join(coord,'read'),'');
 await wait('read-done');await writeFile(path.join(sourceRoot,'input'),'original');await writeFile(path.join(coord,'finish'),'');
 await assert.rejects(running,{code:'GATE_SNAPSHOT_INVALID'});
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

test('a live input with an external hardlink cannot produce isolated evidence',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-hardlink-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 await writeFile(path.join(sourceRoot,'input'),'captured');await link(path.join(sourceRoot,'input'),path.join(directory,'alias'));
 let executed=false;
 await assert.rejects(executeCapturedGate({gate:{id:'check',command:[process.execPath,'-e','process.exit(0)'],files:[{path:'input',content:'captured'}]},directory:snapshots,sourceRoot,command:async()=>{executed=true;return {exitCode:0,stdout:''};}}),{code:'GATE_SNAPSHOT_INVALID'});
 assert.equal(executed,false);
});

test('external live aliases remain unreadable while source bytes change and are restored',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-alias-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 const source=path.join(sourceRoot,'input'),alias=path.join(directory,'alias');await writeFile(source,'original');await link(source,alias);
 const script=`import {readFile} from 'node:fs/promises';try{await readFile(${JSON.stringify(alias)});process.exitCode=9}catch(error){process.stdout.write(error.code)}`;
 await writeFile(path.join(sourceRoot,'check.mjs'),script);
 const command=createAdapters().command;
 const result=await executeCapturedGate({gate:{command:[process.execPath,'check.mjs'],files:[{path:'check.mjs',content:script}]},directory:snapshots,sourceRoot,command:async(...args)=>{await writeFile(source,'changed');try{return await command(...args)}finally{await writeFile(source,'original')}}});
 assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/^(EACCES|EPERM|ENOENT)$/);assert.equal(await readFile(source,'utf8'),'original');
});

test('a hardlink introduced in an allowed runtime path after preflight invalidates the receipt',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-late-alias-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots'),runtime=path.join(directory,'runtime');
 for(const dir of [sourceRoot,snapshots,runtime])await mkdir(dir);
 const input=path.join(sourceRoot,'input'),alias=path.join(runtime,'alias');await writeFile(input,'original');
 const script=`import {readFile} from 'node:fs/promises';process.stdout.write(await readFile(${JSON.stringify(alias)},'utf8'))`;
 await writeFile(path.join(sourceRoot,'check.mjs'),script);const command=createAdapters().command;
 await assert.rejects(executeCapturedGate({gate:{command:[process.execPath,'check.mjs'],config:{runtimePaths:[runtime]},files:[{path:'input',content:'original'},{path:'check.mjs',content:script}]},directory:snapshots,sourceRoot,
  command:async(...args)=>{await link(input,alias);await writeFile(input,'changed');try{return await command(...args)}finally{await writeFile(input,'original');await rm(alias)}}}),{code:'GATE_SNAPSHOT_INVALID'});
});

for (const exitCode of [0,7,'SIGTERM']) test('AC-1 AC-2 copied read-only outputs retain command result '+exitCode,async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-copy-'));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');
 await mkdir(path.join(sourceRoot,'fixture/nested'),{recursive:true});await mkdir(snapshots);
 const external=path.join(directory,'external');await mkdir(external);await writeFile(path.join(external,'keep'),'outside');await chmod(external,0o500);
 t.after(async()=>{await chmod(external,0o700);await rm(directory,{recursive:true,force:true});});
 const script=`import {chmod,cp,mkdir,symlink} from 'node:fs/promises';
 await cp('fixture','output/copied',{recursive:true});
 const nested=process.env.TMPDIR+'/forge-gate-child/gate-inner/.forge-gate-tmp';
 await mkdir(nested,{recursive:true});
 await cp('fixture',nested+'/copied',{recursive:true});
 await chmod(nested+'/copied/nested',0);
 await chmod(nested,0o500);
 await chmod('output/copied/nested',0);
 await symlink(${JSON.stringify(external)},'output/external');
 await symlink('missing','output/dangling');
 console.log('copied');console.error('diagnostic');${exitCode==='SIGTERM'?"process.kill(process.pid,'SIGTERM')":`process.exitCode=${exitCode}`};`;
 const files=[{path:'fixture/nested/input',content:'input'},{path:'copy.mjs',content:script}];
 for(const file of files)await writeFile(path.join(sourceRoot,file.path),file.content);
 const gate={id:'tests',command:[process.execPath,'copy.mjs'],files,outputDirectories:['output']};
 const execution=await executeCapturedGate({gate,directory:snapshots,sourceRoot,command:createAdapters().command});
 if(exitCode==='SIGTERM')assert.equal(execution.signal,exitCode);else assert.equal(execution.exitCode,exitCode);
 assert.equal(execution.stdout,'copied\n');assert.equal(execution.stderr,'diagnostic\n');
 assert.equal(capturedGateReport({gate,execution,reportPath:'captured'}).ok,exitCode===0);
 assert.deepEqual(await readdir(snapshots),[]);
 assert.equal((await stat(external)).mode & 0o777,0o500);assert.equal(await readFile(path.join(external,'keep'),'utf8'),'outside');
 assert.equal(await readFile(path.join(sourceRoot,'fixture/nested/input'),'utf8'),'input');
});

test('AC-1 cleanup ignores a replaced output directory symbolic link',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-cleanup-link-'));
 const external=path.join(directory,'external');await mkdir(external);await writeFile(path.join(external,'keep'),'outside');await chmod(external,0o500);
 t.after(async()=>{await chmod(external,0o700);await rm(directory,{recursive:true,force:true});});
 const snapshot=await createGateSnapshot({directory,files:[{path:'input',content:'captured'}],outputDirectories:['output']});
 await chmod(snapshot.root,0o700);await rm(path.join(snapshot.root,'output'),{recursive:true});await symlink(external,path.join(snapshot.root,'output'));
 await snapshot.cleanup();await snapshot.cleanup();
 assert.equal((await stat(external)).mode & 0o777,0o500);assert.equal(await readFile(path.join(external,'keep'),'utf8'),'outside');
});


for (const changedInput of [false,true]) test('AC-2 cleanup failure retains '+(changedInput?'validation error':'execution diagnostics'),async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-cleanup-error-'));
 const sourceRoot=path.join(directory,'source'),snapshots=path.join(directory,'snapshots');await mkdir(sourceRoot);await mkdir(snapshots);
 await writeFile(path.join(sourceRoot,'input'),'captured');let snapshotRoot;
 const original=fs.rmdir;
 t.mock.method(fs,'rmdir',async item=>{if(item===snapshotRoot)throw Object.assign(new Error('injected cleanup denial'),{code:'EACCES'});return original(item);});syncBuiltinESMExports();
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});});
 const execution={exitCode:7,stdout:'original stdout',stderr:'original stderr'};
 await assert.rejects(executeCapturedGate({gate:{command:[process.execPath,'-e','process.exit(0)'],files:[{path:'input',content:'captured'}],outputDirectories:['output']},directory:snapshots,sourceRoot,
 command:async(binary,args,{cwd})=>{
  snapshotRoot=cwd;
  if(changedInput){await chmod(path.join(cwd,'input'),0o600);await writeFile(path.join(cwd,'input'),'changed');}
  return execution;
 }}),error=>{
  assert.deepEqual(error.execution,execution);
  if(changedInput){assert.equal(error.code,'GATE_SNAPSHOT_INVALID');assert.equal(error.cleanupError.code,'EACCES');}
  else assert.equal(error.code,'EACCES');
  return true;
 });
});

for (const boundary of ['chmod','readdir']) test('AC-1 cleanup confines an ancestor replacement before '+boundary,async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-cleanup-race-'));
 const external=path.join(directory,'external');await mkdir(path.join(external,'victim'),{recursive:true});await writeFile(path.join(external,'victim/keep'),'outside');await chmod(path.join(external,'victim'),0o500);
 let snapshot,fired=false;
 const command=createAdapters().command;
 snapshot=await createGateSnapshot({directory,files:[{path:'input',content:'captured'}],outputDirectories:['output'],command:async(binary,args,options)=>{
  if(!fired){
   fired=true;const index=args.indexOf('-e')+1;
   const prefix=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const original=fs[${JSON.stringify(boundary)}];let replaced=false;
fs[${JSON.stringify(boundary)}]=async function(directory,...rest){
 if(!replaced && directory==='./output') {replaced=true;await fs.rename(directory,directory+'-moved');await fs.symlink(${JSON.stringify(external)},directory);}
 return original(directory,...rest);
};syncBuiltinESMExports();\n`;
   args=[...args];args[index]=prefix+args[index];
  }
  return command(binary,args,options);
 }});
 t.after(async()=>{await snapshot.cleanup();await chmod(path.join(external,'victim'),0o700);await rm(directory,{recursive:true,force:true});});
 await mkdir(path.join(snapshot.root,'output/victim'));await writeFile(path.join(snapshot.root,'output/victim/keep'),'snapshot');
 if(process.env.FORGE_GATE_BROKER){
  // A nested caller cannot inject host code; exercise the escape at its request boundary.
  await chmod(snapshot.root,0o700);
  await fs.rename(path.join(snapshot.root,'output'),path.join(snapshot.root,'output-moved'));
  await symlink(external,path.join(snapshot.root,'output'));
  await snapshot.cleanup();
 } else await assert.rejects(snapshot.cleanup(),error=>['EACCES','EPERM','ENOENT'].includes(error.code));
 assert.equal((await stat(path.join(external,'victim'))).mode & 0o777,0o500);
 assert.equal(await readFile(path.join(external,'victim/keep'),'utf8'),'outside');
});

for (const replacement of ['symlink','directory']) test('AC-1 root replacement cannot authorize an external '+replacement, async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'gate-cleanup-root-race-'));
 const external=path.join(directory,'external');await mkdir(path.join(external,'victim'),{recursive:true});await writeFile(path.join(external,'victim/keep'),'outside');await chmod(path.join(external,'victim'),0o500);
 let snapshot,replaced=false;const command=createAdapters().command;
 const replace=async()=>{replaced=true;await chmod(snapshot.root,0o700);await fs.rename(snapshot.root,snapshot.root+'-moved');if(replacement==='symlink')await symlink(external,snapshot.root);else await fs.rename(external,snapshot.root);};
 snapshot=await createGateSnapshot({directory,files:[{path:'input',content:'captured'}],command:async(binary,args,options)=>{
  if(!replaced)await replace();
  return command(binary,args,options);
 }});
 t.after(async()=>{if(replacement==='symlink')await fs.unlink(snapshot.root);else await fs.rename(snapshot.root,external);await fs.rename(snapshot.root+'-moved',snapshot.root);await snapshot.cleanup();await chmod(path.join(external,'victim'),0o700);await rm(directory,{recursive:true,force:true});});
 if(process.env.FORGE_GATE_BROKER)await replace();
 await assert.rejects(snapshot.cleanup());
 const kept=replacement==='symlink'?external:snapshot.root;
 assert.equal((await stat(path.join(kept,'victim'))).mode & 0o777,0o500);
 assert.equal(await readFile(path.join(kept,'victim/keep'),'utf8'),'outside');
});
