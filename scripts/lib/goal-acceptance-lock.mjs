import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { acquireContinuityLock } from './continuity-lock.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'EFFECT_UNCERTAIN' }); };
export async function withGoalAcceptanceRecoveryLock({ stateRoot, unit, requestDigest }, action) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit ?? '') || ['.', '..'].includes(unit)) throw new TypeError('invalid unit');
  const lockMetadata = { protocol: 'harness.goal-acceptance-lock/1', requestDigest };
  // Only this command's exact dead attempt is reclaimable; legacy/native fence markers are never removed.
  let recoveryLock;
  while (!recoveryLock) {
    try { recoveryLock = await acquireContinuityLock(path.join(path.resolve(stateRoot), 'units', unit, '.goal-acceptance.lock')); }
    catch (error) { if (error.code !== 'GOAL_LOCKED') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  try {
    for (const name of ['.ledger.lock', '.lock']) {
      const file = path.join(path.resolve(stateRoot), 'units', unit, name);
      let bytes;
      try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let marker;
      try { marker = JSON.parse(bytes); } catch { fail('unknown lock marker requires investigation'); }
      if (marker.protocol !== lockMetadata.protocol || marker.requestDigest !== requestDigest || !Number.isSafeInteger(marker.pid) || marker.pid < 1)
        fail('foreign lock marker requires investigation');
      let absent = false;
      try { process.kill(marker.pid, 0); } catch (error) { if (error.code === 'ESRCH') absent = true; else throw error; }
      if (!absent || !(await readFile(file)).equals(bytes)) fail('lock owner is live or uncertain');
      recoveryLock.assertHeld();
      await rm(file);
    }
    return await action(lockMetadata);
  } finally { await recoveryLock.close(); }
}
