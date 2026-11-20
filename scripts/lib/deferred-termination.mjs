// A terminating signal (for example from `timeout`) must not cut a state critical section short: Node's default
// signal exit skips the `finally` that removes the lock marker, leaving an orphaned lock that needs explicit
// recovery. While any state lock is held the signal is deferred and re-raised once the last lock is released.
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
let held = 0, pending = null, installed = false;

function raise(signal) {
  for (const name of signals) process.removeAllListeners(name);
  process.kill(process.pid, signal);
}

export function installDeferredTermination() {
  if (installed) return;
  installed = true;
  for (const signal of signals) process.on(signal, () => {
    if (held === 0) return raise(signal);
    if (!pending) process.stderr.write(`${signal} received; finishing the current state critical section before exiting\n`);
    pending ??= signal;
  });
}

export async function holdingStateLock(action) {
  held += 1;
  try { return await action(); }
  finally {
    held -= 1;
    if (held === 0 && pending) raise(pending);
  }
}
