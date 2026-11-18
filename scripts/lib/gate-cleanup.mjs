import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
const invalid=message=>Object.assign(new Error(message),{code:'GATE_SNAPSHOT_INVALID'});

export async function cleanupGateSnapshot({root,identity,command,platform=process.platform}) {
    let current;
    try { current=await lstat(root,{bigint:true}); } catch (error) { if (error.code==='ENOENT') return; throw error; }
    if (!current.isDirectory() || current.dev.toString()!==identity.dev || current.ino.toString()!==identity.ino) throw invalid('snapshot cleanup root changed');
    const isolatedRoot=await realpath(root);
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
      if (opened.dev.toString()!==identity.dev || opened.ino.toString()!==identity.ino) {await handle.close();throw invalid('snapshot cleanup root changed');}
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
}
