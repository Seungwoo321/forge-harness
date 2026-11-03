import { createGateSnapshot } from './gate-snapshot.mjs';
import { gateFingerprint } from './evidence.mjs';
import { link, lstat, mkdir, open, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const invalid = message => Object.assign(new Error(message),{code:'GATE_SNAPSHOT_INVALID'});
const signature = stat => [stat.dev,stat.ino,stat.mode,stat.size,stat.ctimeNs].join(':');

export async function executeCapturedGate({gate,directory,sourceRoot,command,platform=process.platform}) {
  if (!Array.isArray(gate?.command) || !gate.command.length || gate.command.some(value=>typeof value !== 'string' || !value || value.includes('\0'))
    || !path.isAbsolute(sourceRoot ?? '') || typeof command !== 'function') throw Object.assign(new TypeError('snapshot execution requires an exact command and source root'),{code:'GATE_SNAPSHOT_INVALID'});
  const captured={...gate,command:[...gate.command],files:gate.files?.map(file=>({...file,content:Buffer.isBuffer(file.content) ? Buffer.from(file.content) : file.content})),...(gate.outputDirectories ? {outputDirectories:[...gate.outputDirectories]} : {})};
  const fingerprint = gateFingerprint(captured);
  if (!fingerprint) throw Object.assign(new TypeError('snapshot execution requires fingerprinted inputs'),{code:'GATE_SNAPSHOT_INVALID'});
  const source=await realpath(sourceRoot), parent=await realpath(directory);
  const relative=path.relative(source,parent);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw Object.assign(new Error('snapshot must be outside the live source tree'),{code:'GATE_SNAPSHOT_INVALID'});
  const snapshot=await createGateSnapshot({directory,files:captured.files,outputDirectories:captured.outputDirectories});
  try {
    for (const file of captured.files) {
      const sourceFile=path.join(source,file.path);
      const before=await lstat(sourceFile,{bigint:true});
      const mode=file.mode === undefined ? 0 : typeof file.mode === 'string' ? parseInt(file.mode,8) : file.mode;
      const expectedLink=(mode & 0o170000) === 0o120000;
      if (await realpath(path.dirname(sourceFile)) !== path.dirname(sourceFile)
        || !expectedLink && await realpath(sourceFile) !== sourceFile) throw invalid('gate input traverses an undeclared symbolic link');
      if (expectedLink ? !before.isSymbolicLink() : !before.isFile()) throw invalid('gate input type differs from its declaration');
      const bytes=expectedLink ? Buffer.from(await readlink(sourceFile)) : await readFile(sourceFile),after=await lstat(sourceFile,{bigint:true});
      if (signature(before) !== signature(after) || !bytes.equals(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content)))) throw invalid('declared gate input differs from the live source');
      if (file.mode !== undefined && !expectedLink) {
        if ((Number(before.mode) & 0o111) !== (mode & 0o111)) throw invalid('declared gate input mode differs from the live source');
      }
    }
    let binary,args;
    if (platform === 'darwin') {
      const profile='(version 1)(allow default)(deny file-read* file-write* (subpath (param "GATE_SOURCE")))';
      binary='/usr/bin/sandbox-exec';args=['-D',`GATE_SOURCE=${source}`,'-p',profile,...captured.command];
    } else if (platform === 'linux') {
      binary='bwrap';args=['--die-with-parent','--ro-bind','/','/','--tmpfs',source,'--chdir',snapshot.root,'--',...captured.command];
    } else throw Object.assign(new Error('no supported snapshot isolation backend'),{code:'GATE_SNAPSHOT_UNSUPPORTED'});
    const result=await command(binary,args,{cwd:snapshot.root});
    await snapshot.assertUnchanged();
    return {...result,inputFingerprint:fingerprint};
  } finally { await snapshot.cleanup(); }
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
    execution:{kind:'isolated-snapshot-v1',fingerprint:execution.inputFingerprint}};
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
