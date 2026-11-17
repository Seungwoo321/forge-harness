import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createAdapters } from './adapters.mjs';
import { sessionEffectRetired } from './ledger.mjs';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { archiveLock, lockDigest, lockOwnerStatus, readLock, publishLockFile, withStateLockGuard } from './state-lock.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'LOCK_RECOVERY_UNVERIFIED' }); };
const same = (left, right) => effectArgsDigest(left) === effectArgsDigest(right);

function owner(bytes) {
  try { return JSON.parse(bytes); } catch { return null; }
}

function previousEffects(bytes) {
  const rows = bytes ? bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  return rows.filter(row => row.event === 'intent').map(intent => {
    const result = rows.findLast(row => row.event === 'result' && row.seq === intent.seq && row.key === intent.key);
    return { seq: intent.seq, key: intent.key, effect: intent.effect, intentDigest: effectArgsDigest(intent),
      state: sessionEffectRetired(rows, intent) ? 'retired' : result?.result != null && !['unknown', 'uncertain', 'pending', 'running'].includes(result.result.status) ? 'recorded' : 'unresolved', resultDigest: result ? effectArgsDigest(result) : null };
  });
}

export async function recoverStateLock({ stateRoot, unit, request, userInputRef, adapters }) {
  if (!request || Object.keys(request).sort().join(',') !== 'evidence,kind,lockDigest,reason'
    || !request.evidence || Object.keys(request.evidence).sort().join(',') !== 'digest,path'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit ?? '') || ['.', '..'].includes(unit)
    || !['unit', 'ledger'].includes(request?.kind) || !/^sha256:[a-f0-9]{64}$/.test(request.lockDigest ?? '')
    || typeof request.reason !== 'string' || !request.reason.trim() || typeof userInputRef !== 'string' || !userInputRef.trim()
    || !path.isAbsolute(request.evidence?.path ?? '') || !/^sha256:[a-f0-9]{64}$/.test(request.evidence.digest ?? '')) fail('exact lock, reason, authorization and quiescence evidence are required');
  if (typeof adapters?.provider?.verifyLockRecovery !== 'function') fail('trusted lock recovery verifier is required');
  const dir = path.resolve(stateRoot, 'units', unit);
  const files = { ledger: path.join(dir, '.ledger.lock'), unit: path.join(dir, '.lock') };
  const file = files[request.kind];
  const io = createAdapters();
  // Keep the established cross-resource order, even when only the unit marker is recovered.
  return withStateLockGuard(files.ledger, 'LEDGER', ledgerGuard => withStateLockGuard(files.unit, 'UNIT', async unitGuard => {
    const receiptPath = `${file}.recovery-${effectArgsDigest({ request, userInputRef }).slice(7)}.json`;
    const snapshots = { ledger: await readLock(files.ledger), unit: await readLock(files.unit) };
    const bytes = snapshots[request.kind];
    if (bytes === null) {
      const saved = await readLock(receiptPath);
      if (saved) {
        const receipt = JSON.parse(saved);
        const archive = `${file}.abandoned-${request.lockDigest.slice(7)}`;
        const preserved = await readLock(archive);
        if (same(receipt.request, request) && receipt.userInputRef === userInputRef && receipt.archive === archive
          && preserved !== null && lockDigest(preserved) === request.lockDigest) return { ...receipt, receiptPath, duplicate: true };
      }
      fail('lock observation changed; inspect the current lock');
    }
    if (lockDigest(bytes) !== request.lockDigest) fail('lock observation changed; inspect the current lock');
    const statuses = {};
    for (const [kind, snapshot] of Object.entries(snapshots)) {
      statuses[kind] = snapshot === null ? 'absent' : await lockOwnerStatus(snapshot, io);
      if (snapshot !== null && statuses[kind] !== 'abandoned') fail('every present owner must have an exact positive PID and fresh kernel absence; legacy fences remain reserved');
    }
    const unitFile = path.join(dir, 'unit.json');
    const unitBytes = await readLock(unitFile);
    const goalId = unitBytes ? JSON.parse(unitBytes).continuity?.goalId ?? null : null;
    if (goalId !== null && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(goalId) || ['.', '..'].includes(goalId))) fail('invalid bound goal');
    const goalFile = goalId === null ? null : path.resolve(stateRoot, 'goals', goalId, 'goal.json');
    const goalBytes = goalFile === null ? null : await readLock(goalFile);
    const ledgerFile = path.join(dir, 'ledger.ndjson');
    const ledger = await readLock(ledgerFile);
    const evidence = await readFile(request.evidence.path);
    if (lockDigest(evidence) !== request.evidence.digest) fail('quiescence evidence changed');
    const binding = { purpose: 'critical-section-recovery', stateRoot: await realpath(stateRoot),
      unitDigest: unitBytes === null ? null : lockDigest(unitBytes), goalId, goalDigest: goalBytes === null ? null : lockDigest(goalBytes), unit, kind: request.kind, lockDigest: request.lockDigest, userInputRef,
      argsDigest: effectArgsDigest(request), evidence: request.evidence,
      boundary: ['ledger', 'unit'], locks: Object.entries(snapshots).map(([kind, value]) =>
        ({ kind, status: statuses[kind], digest: value === null ? null : lockDigest(value), owner: value === null ? null : owner(value) })),
      ledgerDigest: ledger === null ? null : lockDigest(ledger), previousEffects: previousEffects(ledger) };
    await verifyApprovalInput(adapters.provider, { unit, kind: request.kind, userInputRef, effect: 'unit.lock.recover',
      argsDigest: binding.argsDigest, stateRoot: binding.stateRoot, unitDigest: binding.unitDigest, goalId, goalDigest: binding.goalDigest,
      lockDigest: binding.lockDigest, ledgerDigest: binding.ledgerDigest, bindingDigest: effectArgsDigest(binding), reason: request.reason });
    const proof = await adapters.provider.verifyLockRecovery(structuredClone(binding));
    if (proof?.verified !== true || proof.ownerFenced !== true || proof.legacyWritersFenced !== true || proof.legacyLeaseAbsent !== true
      || Object.entries(binding).some(([key, value]) => !same(proof[key], value))) fail('original owner, legacy clients and original authorization are not conclusively fenced');
    const unresolved = binding.previousEffects.filter(item => item.state === 'unresolved');
    if (!Array.isArray(proof.externalEffects) || proof.externalEffects.length !== unresolved.length
      || unresolved.some(effect => !proof.externalEffects.some(item => item.seq === effect.seq && item.key === effect.key
        && item.intentDigest === effect.intentDigest && ['pending', 'completed', 'not-applied', 'unknown'].includes(item.status)
        && typeof item.evidence === 'string' && item.evidence.trim()))) fail('every unresolved external effect requires a bound observation; pending effects remain unreconciled');
    ledgerGuard.assertHeld(); unitGuard.assertHeld();
    if (!(await readFile(request.evidence.path)).equals(evidence) || !same(await readLock(ledgerFile), ledger)
      || !same(await readLock(unitFile), unitBytes) || goalFile !== null && !same(await readLock(goalFile), goalBytes)) fail('recovery inputs changed during verification');
    for (const [kind, snapshot] of Object.entries(snapshots)) {
      if (!same(await readLock(files[kind]), snapshot) || snapshot !== null && await lockOwnerStatus(snapshot, io) !== 'abandoned') fail('lock observation or exact owner absence changed during verification');
    }
    const receipt = { request, userInputRef, proof, archive: `${file}.abandoned-${request.lockDigest.slice(7)}` };
    const saved = await readLock(receiptPath);
    if (saved && !same(JSON.parse(saved), receipt)) fail('recovery receipt already binds different proof');
    if (!saved) await publishLockFile(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), io);
    ledgerGuard.assertHeld(); unitGuard.assertHeld();
    await archiveLock(file, bytes);
    return { ...receipt, receiptPath };
  }, io), io);
}
