import { createHash } from 'node:crypto';
import { open, readFile, link, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createAdapters } from './adapters.mjs';
import { holdingStateLock } from './deferred-termination.mjs';

const defaultAdapters = createAdapters();
const failure = (kind, suffix, message) => Object.assign(new Error(message), { code: `${kind}_LOCK_${suffix}` });
export const lockDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function readLock(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function publishLockFile(file, bytes, adapters) {
  const temporary = `${file}.tmp-${adapters.id()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await link(temporary, file);
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

export async function archiveLock(file, bytes) {
  const archive = `${file}.abandoned-${lockDigest(bytes).slice(7)}`;
  try { await link(file, archive); } catch (error) {
    if (error.code !== 'EEXIST' || !bytes.equals(await readFile(archive))) throw error;
  }
  const preserved = await open(path.dirname(file),'r');
  try{await preserved.sync();}finally{await preserved.close();}
  if (!(await readFile(file)).equals(bytes)) throw new Error('lock changed while fenced');
  await rm(file);
  const dir = await open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return archive;
}

export async function withStateLockGuard(file, kind, action, adapters = defaultAdapters, {wait=true} = {}) {
  return holdingStateLock(() => guardedStateLock(file, kind, action, adapters, wait));
}

async function guardedStateLock(file, kind, action, adapters, wait) {
  await mkdir(path.dirname(file), { recursive: true });
  let guard;
  try { guard = await adapters.stateLock(`${file}.guard`,{wait}); }
  catch (cause) { if(cause.code==='GOAL_LOCKED')throw Object.assign(new Error(cause.message),{code:`${kind}_LOCKED`});throw failure(kind,'UNAVAILABLE',cause.message); }
  try { return await action(guard); } finally { await guard.close(); }
}

export async function lockOwnerStatus(bytes, adapters) {
  let owner;
  try { owner = JSON.parse(bytes); } catch { return 'unknown'; }
  if (owner?.protocol === 'harness.legacy-fence/1' || owner?.purpose === 'legacy-fence') return 'fence';
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || owner.purpose !== undefined && owner.purpose !== 'critical-section') return 'unknown';
  const observed = await adapters.processIdentity(owner.pid);
  // Incarnation mismatch never authorizes reclaiming a reused, currently live PID.
  return observed.status === 'gone' ? 'abandoned' : observed.status;
}
