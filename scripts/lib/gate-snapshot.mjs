import { mkdtemp, mkdir, open, readFile, readlink, rmdir, chmod, lstat, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createAdapters } from './adapters.mjs';
import { constants } from 'node:fs';

const invalid = message => Object.assign(new Error(message), {code:'GATE_SNAPSHOT_INVALID'});
const signature = stat => [stat.dev,stat.ino,stat.mode,stat.size,stat.ctimeNs].join(':');

// Materialize the captured bytes rather than reading the live worktree again.
export async function createGateSnapshot({ directory, files, outputDirectories = [], command = createAdapters().command, platform = process.platform }) {
  if (!path.isAbsolute(directory ?? '') || !Array.isArray(files) || !files.length || !Array.isArray(outputDirectories)) throw invalid('snapshot directory and inputs are required');
  const seen = new Set();
  const entries = files.map(file => {
    const name = file?.path;
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || path.isAbsolute(name)
      || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name) || file.content === undefined) throw invalid('snapshot input path or content is invalid');
    seen.add(name);
    const bytes = Buffer.isBuffer(file.content) ? Buffer.from(file.content) : Buffer.from(String(file.content));
    const mode = file.mode === undefined ? 0 : typeof file.mode === 'string' && /^[0-7]+$/.test(file.mode) ? parseInt(file.mode,8) : file.mode;
    if (!Number.isSafeInteger(mode) || mode < 0) throw invalid('snapshot input mode is invalid');
    const link=(mode & 0o170000) === 0o120000;
    if (link) {
      const target=bytes.toString('utf8'), resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),target));
      if (!Buffer.from(target).equals(bytes) || !target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)
        || resolved === '..' || resolved.startsWith('../')) throw invalid('snapshot symbolic link escapes its input tree');
    }
    return {name,bytes,mode,link};
  });
  const links=new Set(entries.filter(entry=>entry.link).map(entry=>entry.name));
  for (const entry of entries) {
    const parts=entry.name.split('/');
    for (let i=1;i<parts.length;i+=1) if (links.has(parts.slice(0,i).join('/'))) throw invalid('snapshot input traverses another input symbolic link');
  }
  const outputs=new Set();
  for (const name of outputDirectories) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || path.isAbsolute(name)
      || name.split('/').some(part=>!part || part==='.' || part==='..') || outputs.has(name)
      || entries.some(entry=>entry.name===name || entry.name.startsWith(`${name}/`) || name.startsWith(`${entry.name}/`))
      || [...outputs].some(other=>other.startsWith(`${name}/`) || name.startsWith(`${other}/`))) throw invalid('snapshot output directory overlaps an input or escapes its tree');
    outputs.add(name);
  }
  await mkdir(directory, {recursive:true,mode:0o700});
  const root = await mkdtemp(path.join(directory,'gate-'));
  const directories = new Set([root]);
  const identity = await lstat(root,{bigint:true});
  const isolatedRoot = await realpath(root);
  const cleanup = async () => {
    let current;
    try { current=await lstat(root,{bigint:true}); } catch (error) { if (error.code==='ENOENT') return; throw error; }
    if (!current.isDirectory() || current.dev!==identity.dev || current.ino!==identity.ino) throw invalid('snapshot cleanup root changed');
    const script=`import {chmod,lstat,readdir,rm} from 'node:fs/promises';
const root='.';
const expected=process.argv.slice(1);
const invalid=()=>Object.assign(new Error('snapshot cleanup root changed'),{code:'GATE_SNAPSHOT_INVALID'});
async function writable(directory) {
  if (!(await lstat(directory)).isDirectory()) return;
  await chmod(directory,0o700);
  for (const entry of await readdir(directory,{withFileTypes:true})) if (entry.isDirectory()) await writable(directory+'/'+entry.name);
}
try {
  const identity=await lstat(root,{bigint:true});
  if (identity.dev.toString()!==expected[0] || identity.ino.toString()!==expected[1]) throw invalid();
  await writable(root);
  for (const entry of await readdir(root)) await rm(root+'/'+entry,{recursive:true,force:true});
} catch (error) { console.error(JSON.stringify({code:error.code,message:error.message}));process.exitCode=1; }`;
    const nodeRoot=path.dirname(path.dirname(await realpath(process.execPath)));
    let binary,args,handle;
    if (platform==='darwin') {
      const roots=[isolatedRoot,'/System','/usr','/bin','/sbin','/dev','/Library/Apple','/private/preboot','/private/var/db/dyld','/opt/homebrew/Cellar','/opt/homebrew/opt',nodeRoot];
      const profile=`(version 1)(allow default)(deny file-read-data file-write*)(allow file-read-data (literal "/") ${roots.map(item=>`(subpath ${JSON.stringify(item)})`).join(' ')})(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(isolatedRoot)}))`;
      binary='/usr/bin/sandbox-exec';args=['-p',profile];
    } else if (platform==='linux') {
      binary='bwrap';args=['--die-with-parent','--unshare-all','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
      for (const item of new Set(['/usr','/bin','/sbin','/lib','/lib64','/etc',nodeRoot])) {
        try { await lstat(item);args.push('--ro-bind',item,item); } catch (error) { if (error.code!=='ENOENT') throw error; }
      }
      handle=await open(root,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened=await handle.stat({bigint:true});
      if (opened.dev!==identity.dev || opened.ino!==identity.ino) {await handle.close();throw invalid('snapshot cleanup root changed');}
      args.push('--bind',`/proc/${process.pid}/fd/${handle.fd}`,'/snapshot','--chdir','/snapshot','--');
    } else throw invalid('no supported snapshot cleanup isolation backend');
    // Descendant path races stay inside the same OS boundary as gate execution.
    let result;
    try { result=await command(binary,[...args,process.execPath,'--input-type=module','-e',script,identity.dev.toString(),identity.ino.toString()],{cwd:root,env:{NODE_OPTIONS:'',OPENSSL_CONF:'/dev/null'}}); }
    finally { await handle?.close(); }
    if (result.exitCode!==0 || result.signal) {
      let diagnostic;try { diagnostic=JSON.parse(result.stderr.trim()); } catch {}
      throw Object.assign(new Error(diagnostic?.message ?? 'isolated snapshot cleanup failed'),{code:diagnostic?.code ?? 'GATE_SNAPSHOT_CLEANUP_FAILED',cleanupResult:result});
    }
    // The isolated process removes descendants; the host only removes the same empty root.
    current=await lstat(root,{bigint:true});
    if (!current.isDirectory() || current.dev!==identity.dev || current.ino!==identity.ino) throw invalid('snapshot cleanup root changed');
    await rmdir(root);
  };
  try {
    for (const entry of entries) {
      const target = path.join(root,entry.name), parent = path.dirname(target);
      await mkdir(parent,{recursive:true,mode:0o700});
      for (let current=parent;current!==root;current=path.dirname(current)) directories.add(current);
      if (entry.link) await symlink(entry.bytes.toString('utf8'),target);
      else {
        const output = await open(target,'wx',entry.mode & 0o111 ? 0o500 : 0o400);
        try { await output.writeFile(entry.bytes); await output.sync(); } finally { await output.close(); }
      }
    }
    for (const name of outputs) {
      const target=path.join(root,name);await mkdir(target,{recursive:true,mode:0o700});
      for (let current=target;current!==root;current=path.dirname(current)) directories.add(current);
    }
    for (const entry of entries) {
      const target=path.join(root,entry.name), bytes=entry.link ? Buffer.from(await readlink(target)) : await readFile(target);
      if (!bytes.equals(entry.bytes)) throw invalid('snapshot bytes differ from captured input');
    }
    const writable=new Set([...outputs].map(name=>path.join(root,name)));
    for (const item of [...directories].sort((a,b)=>b.length-a.length)) await chmod(item,writable.has(item) ? 0o700 : 0o500);
    const paths = [...directories, ...entries.map(entry=>path.join(root,entry.name))];
    const signatures = new Map();
    const metadata = (item,stat) => writable.has(item) ? [stat.dev,stat.ino,stat.mode].join(':') : signature(stat);
    for (const item of paths) signatures.set(item,metadata(item,await lstat(item,{bigint:true})));
    const assertUnchanged = async () => {
      try {
        for (const item of paths) if (metadata(item,await lstat(item,{bigint:true})) !== signatures.get(item)) throw invalid('snapshot input changed during execution');
        for (const entry of entries) {
          const file=path.join(root,entry.name);
          const bytes=entry.link ? Buffer.from(await readlink(file)) : await readFile(file);
          if (!bytes.equals(entry.bytes) || signature(await lstat(file,{bigint:true})) !== signatures.get(file)) throw invalid('snapshot input changed during execution');
        }
      } catch (error) { if (error.code === 'GATE_SNAPSHOT_INVALID') throw error; throw invalid('snapshot input cannot be reverified'); }
    };
    return {root,assertUnchanged,cleanup};
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { error.cleanupError=cleanupError; }
    throw error;
  }
}
