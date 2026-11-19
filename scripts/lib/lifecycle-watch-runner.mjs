import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchStore, runnableWatches, tickWatches } from './lifecycle-watch.mjs';

const script = fileURLToPath(new URL('../watch-runner.mjs',import.meta.url));

export async function ensureWatchRunner({stateRoot,io}) {
  const store = createWatchStore(stateRoot,io);
  return store.transaction(async (data,save) => {
    if (!runnableWatches(data.watches)) return {status:'idle'};
    if (data.runner) {
      if (data.runner.host && data.runner.host !== io.host()) return {status:'unknown',...data.runner};
      const owner = await io.processIdentity(data.runner.pid);
      // A live reused PID or unverifiable owner never permits replacement.
      if (owner.status !== 'gone') return {status:owner.status === 'live' && (!data.runner.incarnation || data.runner.incarnation === owner.incarnation) ? 'running' : 'unknown',...data.runner};
    }
    const child = await io.detach(process.execPath,[script,'--state-root',path.resolve(stateRoot)],{cwd:store.directory,logPath:path.join(store.directory,'runner.log')});
    data.runner = {pid:child.pid,host:io.host()}; await save();
    return {status:'starting',...data.runner};
  });
}

export async function serveWatches({stateRoot,io,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pid=process.pid}) {
  const store = createWatchStore(stateRoot,io);
  let lock;
  try { lock = await io.stateLock(path.join(store.directory,'.runner.lock'),{wait:false}); }
  catch (error) { if (error.code === 'GOAL_LOCKED') return; throw error; }
  try {
    const claimed = await store.transaction(async (data,save) => {
      if (data.runner?.pid !== pid || data.runner.host !== io.host()) return false;
      data.runner.incarnation = (await io.processIdentity(pid)).incarnation ?? null;
      await save(); return true;
    });
    if (!claimed) return;
    while (true) {
      lock.assertHeld();
      await tickWatches({stateRoot,io});
      const active = await store.transaction(async (data,save) => {
        if (data.runner?.pid !== pid) return false;
        if (runnableWatches(data.watches)) return true;
        // Release the singleton before publishing vacancy, while ensure is still fenced by the store lock.
        await lock.close(); lock = null;
        data.runner = null; await save(); return false;
      });
      if (!active) break;
      await wait(1000);
    }
  } finally { if (lock) await lock.close(); }
}
