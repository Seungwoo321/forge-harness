import { spawn } from 'node:child_process';

// The child holds an OS advisory lock until the parent closes its stdin or exits.
// The readiness window only bounds a hung utility; real contention exits at once, so process startup under load must fit inside it.
export async function acquireContinuityLock(file, { wait = false, launch = spawn, readyTimeoutMs = 60000 } = {}) {
  const darwin = process.platform === 'darwin';
  const windows = process.platform === 'win32';
  if (!darwin && !windows && process.platform !== 'linux') throw Object.assign(new Error('goal locking requires a supported native lock utility'),{code:'GOAL_LOCK_UNAVAILABLE'});
  const binary = darwin ? 'lockf' : windows ? 'powershell.exe' : 'flock';
  const args = windows ? ['-NoProfile','-NonInteractive','-Command',
    `while ($true) { try { $f=[System.IO.File]::Open($env:FORGE_LOCK_FILE,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); break } catch [System.IO.IOException] { if (($_.Exception.HResult -band 65535) -notin @(32,33)) { exit 2 }; ${wait ? 'Start-Sleep -Milliseconds 10' : 'exit 75'} } catch { exit 2 } }; [Console]::Out.WriteLine("ready"); [Console]::In.ReadToEnd() | Out-Null; $f.Dispose()`]
    : darwin ? ['-k', ...(wait ? [] : ['-t','0']), file] : [...(wait ? [] : ['-n']), file];
  if (!windows) args.push('/bin/sh','-c','printf "ready\\n"; exec /bin/cat >/dev/null');
  const child = launch(binary,args,{stdio:['pipe','pipe','pipe'],...(windows ? {env:{...process.env,FORGE_LOCK_FILE:file}} : {})});
  child.stdin.on('error',()=>{});
  await new Promise((resolve,reject) => {
    let output = '', error = '';
    const timeout = wait ? null : setTimeout(()=>{ child.stdin.destroy(); child.kill(); reject(Object.assign(new Error('goal lock acquisition timed out'),{code:'GOAL_LOCK_UNAVAILABLE'})); },readyTimeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.replaceAll('\r\n','\n').includes('ready\n')) { clearTimeout(timeout); resolve(); } });
    child.stderr.on('data', chunk => { if (error.length < 2048) error += chunk; });
    child.once('error', cause => { clearTimeout(timeout); reject(Object.assign(new Error(`goal lock utility failed: ${cause.message}`),{code:'GOAL_LOCK_UNAVAILABLE'})); });
    child.once('exit', code => { clearTimeout(timeout); reject(Object.assign(new Error(error.trim() || 'goal is owned by another process'),{code:code === 75 || (!darwin && !windows && code === 1) ? 'GOAL_LOCKED' : 'GOAL_LOCK_UNAVAILABLE'})); });
  });
  return {
    assertHeld() { if (child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error('goal lock was lost'),{code:'GOAL_LOCK_UNAVAILABLE'}); },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) { child.stdin.destroy(); return; }
      await new Promise(resolve => { child.once('exit',resolve); child.stdin.end(); });
    },
  };
}
