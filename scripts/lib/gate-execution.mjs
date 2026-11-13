import { createGateBroker, gateBrokerEnvironment, brokerCommandBootstrap } from './gate-broker.mjs';
import { createGateSnapshot } from './gate-snapshot.mjs';
import { gateFingerprint } from './evidence.mjs';
import { link, lstat, mkdir, open, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const invalid = message => Object.assign(new Error(message),{code:'GATE_SNAPSHOT_INVALID'});
const signature = stat => [stat.dev,stat.ino,stat.mode,stat.size,stat.ctimeNs].join(':');
const macSystemRoots=['/System','/usr','/bin','/sbin','/dev','/Library/Apple','/private/preboot','/private/var/db/dyld','/opt/homebrew/Cellar','/opt/homebrew/opt'];
const subpaths=roots=>roots.map(root=>`(subpath ${JSON.stringify(root)})`).join(' ');
function macProfile({source,root,tools,boundaries=[]}) {
  const roots=[root,...tools];
  return `(version 1)(allow default)(deny file-read-data file-write*)(allow file-read-data (literal "/") ${subpaths(roots)})(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(root)}))(deny file-read* file-write* (subpath ${JSON.stringify(source)}))`
    + boundaries.map(boundary=>`(deny file-read-data (require-not (require-any (literal "/") ${subpaths([boundary.root,...boundary.tools])})))(deny file-write* (require-not (require-any (literal "/dev/null") ${subpaths(boundary.outputs)})))(deny file-read* file-write* (subpath ${JSON.stringify(boundary.source)}))(deny file-read* file-write* file-link (literal ${JSON.stringify(boundary.secret)}))`).join('');
}

export async function executeCapturedGate({gate,directory,sourceRoot,command,platform=process.platform}) {
  if (!Array.isArray(gate?.command) || !gate.command.length || gate.command.some(value=>typeof value !== 'string' || !value || value.includes('\0'))
    || !path.isAbsolute(sourceRoot ?? '') || typeof command !== 'function') throw Object.assign(new TypeError('snapshot execution requires an exact command and source root'),{code:'GATE_SNAPSHOT_INVALID'});
  const captured={...gate,...(gate.config === undefined ? {} : {config:structuredClone(gate.config)}),command:[...gate.command],files:gate.files?.map(file=>({...file,content:Buffer.isBuffer(file.content) ? Buffer.from(file.content) : file.content})),...(gate.outputDirectories ? {outputDirectories:[...gate.outputDirectories]} : {})};
  if (captured.config?.nestedIsolation !== undefined && captured.config.nestedIsolation !== 'sibling-sandbox') throw invalid('unsupported nested isolation mode');
  const fingerprint = gateFingerprint(captured);
  if (!fingerprint) throw Object.assign(new TypeError('snapshot execution requires fingerprinted inputs'),{code:'GATE_SNAPSHOT_INVALID'});
  const source=await realpath(sourceRoot), parent=await realpath(directory);
  const relative=path.relative(source,parent);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw Object.assign(new Error('snapshot must be outside the live source tree'),{code:'GATE_SNAPSHOT_INVALID'});
  const temporaryDirectory='.forge-gate-tmp';
  if (captured.files.some(file=>file.path===temporaryDirectory || file.path.startsWith(`${temporaryDirectory}/`))) throw invalid('reserved gate temporary directory overlaps input');
  const snapshot=await createGateSnapshot({directory,files:captured.files,outputDirectories:[...(captured.outputDirectories ?? []),temporaryDirectory]});
  const isolatedRoot=await realpath(snapshot.root);
  const sourceInputs = [];
  let broker;
  try {
    for (const file of captured.files) {
      const sourceFile=path.join(source,file.path);
      const before=await lstat(sourceFile,{bigint:true});
      const mode=file.mode === undefined ? 0 : typeof file.mode === 'string' ? parseInt(file.mode,8) : file.mode;
      const expectedLink=(mode & 0o170000) === 0o120000;
      if (await realpath(path.dirname(sourceFile)) !== path.dirname(sourceFile)
        || !expectedLink && await realpath(sourceFile) !== sourceFile) throw invalid('gate input traverses an undeclared symbolic link');
      if (expectedLink ? !before.isSymbolicLink() : !before.isFile()) throw invalid('gate input type differs from its declaration');
      if (!expectedLink && before.nlink !== 1n) throw invalid('gate input has external hardlink aliases');
      const bytes=expectedLink ? Buffer.from(await readlink(sourceFile)) : await readFile(sourceFile),after=await lstat(sourceFile,{bigint:true});
      if (signature(before) !== signature(after) || !expectedLink && after.nlink !== 1n || !bytes.equals(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content)))) throw invalid('declared gate input differs from the live source');
      sourceInputs.push({path:sourceFile,signature:signature(after)});
      if (file.mode !== undefined && !expectedLink) {
        if ((Number(before.mode) & 0o111) !== (mode & 0o111)) throw invalid('declared gate input mode differs from the live source');
      }
    }
    let binary,args,capturedGate;
    if (platform === 'darwin') {
      const runtimePaths=captured.config?.runtimePaths ?? [];
      if (!Array.isArray(runtimePaths) || runtimePaths.some(value=>typeof value!=='string' || !path.isAbsolute(value))) throw invalid('runtime paths must be absolute tool locations');
      const roots=[...macSystemRoots,path.dirname(path.dirname(await realpath(process.execPath)))];
      for (const value of runtimePaths) {
        const root=await realpath(value), relative=path.relative(root,source);
        if (!relative || relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw invalid('runtime tool location contains the live source');
        roots.push(root);
      }
      const profile=macProfile({source,root:isolatedRoot,tools:roots});
      binary='/usr/bin/sandbox-exec';args=['-p',profile,...captured.command];
      capturedGate={sourceRoot:source,snapshotRoot:isolatedRoot,temporaryRoot:path.join(isolatedRoot,temporaryDirectory),runtimePaths:roots,command:captured.command,outputRoots:[...(captured.outputDirectories ?? []),temporaryDirectory].map(name=>path.join(isolatedRoot,name))};
      if (captured.config?.nestedIsolation === 'sibling-sandbox' && !process.env[gateBrokerEnvironment]) {
        const outputs=[...(captured.outputDirectories ?? []),temporaryDirectory].map(name=>path.join(isolatedRoot,name));
        broker=await createGateBroker({root:isolatedRoot,outputs,runtimePaths:roots,boundaries:[{root:isolatedRoot,tools:roots,outputs,source,secret:path.join(isolatedRoot,temporaryDirectory,'.broker-capability')}],execute:async (input,endpoint,boundaries)=>{
          const profile=macProfile({source:input.sourceRoot,root:input.snapshotRoot,tools:input.runtimePaths,
            boundaries});
          return command('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'-e',brokerCommandBootstrap],{cwd:input.snapshotRoot,
            env:{OPENSSL_CONF:'/dev/null'},input:JSON.stringify({command:input.command,endpoint,
              env:{...input.env,TMPDIR:input.temporaryRoot,XDG_RUNTIME_DIR:input.temporaryRoot,OPENSSL_CONF:'/dev/null'}})});
        }});
      }
    } else if (platform === 'linux') {
      binary='bwrap';args=['--die-with-parent','--unshare-all','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
      for (const root of ['/usr','/bin','/sbin','/lib','/lib64','/etc']) {
        try { await lstat(root); args.push('--ro-bind',root,root); } catch (error) { if (error.code!=='ENOENT') throw error; }
      }
      const runtimePaths=captured.config?.runtimePaths ?? [];
      if (!Array.isArray(runtimePaths) || runtimePaths.some(value=>typeof value!=='string' || !path.isAbsolute(value))) throw invalid('runtime paths must be absolute tool locations');
      for (const value of runtimePaths) {
        const root=await realpath(value), relative=path.relative(root,source);
        if (!relative || relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw invalid('runtime tool location contains the live source');
        args.push('--ro-bind',root,root);
      }
      args.push('--tmpfs',source,'--bind',isolatedRoot,'/workspace','--chdir','/workspace','--',...captured.command);
    } else throw Object.assign(new Error('no supported snapshot isolation backend'),{code:'GATE_SNAPSHOT_UNSUPPORTED'});
    const temporaryRoot=platform==='linux'?`/workspace/${temporaryDirectory}`:path.join(snapshot.root,temporaryDirectory);
    const env={TMPDIR:temporaryRoot,XDG_RUNTIME_DIR:temporaryRoot,OPENSSL_CONF:'/dev/null'};
    const input=broker ? JSON.stringify({command:captured.command,env:{...process.env,...env},endpoint:broker.endpoint}) : undefined;
    if(broker)args=[...args.slice(0,2),process.execPath,'-e',brokerCommandBootstrap];
    const result=await command(binary,args,{cwd:snapshot.root,...(capturedGate ? {capturedGate} : {}),env,...(input === undefined ? {} : {input})});
    if (broker) { await broker.close(); broker=null; result.isolationBackend='macos-sibling-sandbox-host-v1'; }
    for (const input of sourceInputs) {
      if (signature(await lstat(input.path,{bigint:true})) !== input.signature) throw invalid('live gate input changed during execution');
    }
    await snapshot.assertUnchanged();
    return {...result,inputFingerprint:fingerprint};
  } finally { try { await broker?.close(); } finally { await snapshot.cleanup(); } }
}

export function capturedGateReport({gate,execution,reportPath}) {
  if (!execution || execution.inputFingerprint !== gateFingerprint(gate) || typeof execution.stdout !== 'string'
    || typeof reportPath !== 'string' || !reportPath) throw invalid('captured gate execution does not match its input');
  let exit = Number.isInteger(execution.exitCode) && !execution.signal ? execution.exitCode : 2;
  let parsed={};
  if (gate.resultFormat === 'json') {
    try { parsed=JSON.parse(execution.stdout); } catch { parsed=null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.ok !== 'boolean' || !Array.isArray(parsed.covers) || parsed.covers.some(id=>typeof id !== 'string' || !id)) {
      parsed={ok:false,covers:[],failureClass:'harness'};
      if (exit === 0) exit=1;
    }
  } else if (gate.resultFormat !== undefined && gate.resultFormat !== 'text') throw invalid('unsupported captured gate output format');
  return {exit,ok:exit === 0 && (gate.resultFormat === 'json' ? parsed.ok : true),report:execution.stdout,reportPath,
    covers:gate.resultFormat === 'json' && exit === 0 ? parsed.covers : [],
    ...(parsed.judge !== undefined ? {judge:parsed.judge} : {}),
    ...(exit !== 0 ? {failureClass:parsed.failureClass ?? 'unknown'} : {}),
    execution:{kind:'isolated-snapshot-v1',fingerprint:execution.inputFingerprint,...(execution.isolationBackend ? {backend:execution.isolationBackend} : {})}};
}

export async function persistCapturedReport({stateRoot,unit,content}) {
  if (!path.isAbsolute(stateRoot ?? '') || typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit)
    || unit === '..' || typeof content !== 'string') throw invalid('captured report path or content is invalid');
  const directory=path.join(stateRoot,'units',unit,'gate-reports');await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,`${createHash('sha256').update(content).digest('hex')}.log`);
  const temporary=`${file}.tmp-${randomUUID()}`;
  try {
    const handle=await open(temporary,'wx',0o600);
    try {await handle.writeFile(content);await handle.sync();} finally {await handle.close();}
    try { await link(temporary,file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(file)).isFile() || await readFile(file,'utf8') !== content) throw invalid('existing captured report content differs');
    }
    const dir=await open(directory,'r');try {await dir.sync();} finally {await dir.close();}
  } finally {await rm(temporary,{force:true});}
  return file;
}
