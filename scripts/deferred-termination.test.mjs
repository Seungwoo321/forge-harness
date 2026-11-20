import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = path.dirname(fileURLToPath(new URL('./lib/ledger.mjs', import.meta.url)));

// A child holds a real ledger lock; the parent sends a terminating signal while it is held.
async function child(t, holdMs) {
  const root = await mkdtemp(path.join(tmpdir(), 'deferred-termination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'child.mjs');
  await writeFile(script, `import { installDeferredTermination } from ${JSON.stringify(path.join(lib, 'deferred-termination.mjs'))};
import { createLedgerStore } from ${JSON.stringify(path.join(lib, 'ledger.mjs'))};
installDeferredTermination();
if (${holdMs} === 0) { process.stdout.write('ready\\n'); setInterval(() => {}, 1000); }
else await createLedgerStore(${JSON.stringify(root)}).withLock('u', async ledger => {
  process.stdout.write('ready\\n');
  await new Promise(resolve => setTimeout(resolve, ${holdMs}));
  await ledger.append({ event: 'intent', seq: 1, key: 'k', effect: 'session.start', args: {} });
});
process.stdout.write('after\\n');`);
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
  await new Promise(resolve => { const check = () => stdout.includes('ready') ? resolve() : setTimeout(check, 10); check(); });
  return { root, proc, out: () => stdout, err: () => stderr };
}

test('a terminating signal waits for the held state lock to be released, then exits with that signal', async t => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const c = await child(t, 600);
    const lock = path.join(c.root, 'units', 'u', '.ledger.lock');
    assert.ok(existsSync(lock));
    c.proc.kill(signal);
    const [code, received] = await new Promise(resolve => c.proc.on('exit', (...args) => resolve(args)));
    assert.equal(code, null); assert.equal(received, signal);
    assert.equal(existsSync(lock), false, 'the lock marker is removed instead of orphaned');
    assert.ok(existsSync(path.join(c.root, 'units', 'u', 'ledger.ndjson')), 'the critical section completed');
    assert.equal(c.out().includes('after'), false, 'no further work runs after the deferred signal');
    assert.match(c.err(), new RegExp(`${signal} received; finishing the current state critical section`));
  }
});

test('a terminating signal with no state lock held exits immediately', async t => {
  const c = await child(t, 0);
  c.proc.kill('SIGTERM');
  const [code, received] = await new Promise(resolve => c.proc.on('exit', (...args) => resolve(args)));
  assert.equal(code, null); assert.equal(received, 'SIGTERM'); assert.equal(c.err(), '');
});
