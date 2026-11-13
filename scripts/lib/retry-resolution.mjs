import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRecoveryStore } from './recovery-store.mjs';
import { effectArgsDigest } from './approvals.mjs';
import { attemptsFor } from './stage-attempts.mjs';
import { continuationError, gateTarget } from './gate-continuation.mjs';
import { resolvePolicy } from './policy.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

export async function verifyRetryEvidence({ stateRoot, receipt }) {
  if (receipt.request.classification) {
    const baseline = receipt.capturedGate?.baseline;
    let report;
    try { report = await readFile(baseline?.report); } catch {}
    if (!report || hash(report) !== baseline.digest) throw continuationError('EVIDENCE_STALE', 'the captured gate report changed');
  }
  const failureBytes = await readFile(path.join(stateRoot, receipt.failureRef.path));
  if (hash(failureBytes) !== receipt.failureRef.digest || effectArgsDigest(JSON.parse(failureBytes)) !== effectArgsDigest(receipt.failure)) {
    throw continuationError('EVIDENCE_STALE', 'the original failure changed after correction verification');
  }
}

export async function verifyRetryResolution({ stateRoot, record, receipt, adapters }) {
  await verifyRetryEvidence({ stateRoot, receipt });
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  if (policy.retry.onExhaustion !== 'root-cause' || effectArgsDigest(policy.retry) !== effectArgsDigest(receipt.policy)) {
    throw continuationError('RETRY_NOT_ALLOWED', 'the explicitly authorized retry policy changed');
  }
  const target = gateTarget(await adapters.git?.inspectUnit({ unit: record.unit, record }));
  if (effectArgsDigest(target) !== receipt.targetDigest) throw continuationError('EVIDENCE_STALE', 'verified correction target changed');
  if (typeof adapters.provider?.verifyRetryResolution !== 'function') {
    throw continuationError('ADAPTER_MISSING', 'a trusted retry-resolution verifier is required');
  }
  const binding = { unit: record.unit, failureId: receipt.failure.id, causeKey: receipt.failure.causeKey,
    requestDigest: receipt.requestDigest, targetDigest: receipt.targetDigest,
    diagnosisDigest: effectArgsDigest(receipt.diagnosis), policyDigest: effectArgsDigest(receipt.policy) };
  const proof = await adapters.provider.verifyRetryResolution({
    ...binding, request: structuredClone(receipt.request), failure: structuredClone(receipt.failure),
    diagnosis: structuredClone(receipt.diagnosis), policy: structuredClone(receipt.policy), target,
    gateRecovery: structuredClone(receipt.capturedGate ?? record.gateRecovery ?? null),
    previous: structuredClone(record.retryResolutions ?? []),
  });
  if (!proof || proof.verified !== true || proof.resolved !== true
    || Object.entries(binding).some(([key, value]) => proof[key] !== value)
    || !/^sha256:[a-f0-9]{64}$/.test(proof.progressDigest ?? '')) {
    throw continuationError('RETRY_RESOLUTION_UNPROVEN', 'the correction and successful revalidation must be independently observed');
  }
  if (effectArgsDigest(gateTarget(await adapters.git?.inspectUnit({ unit: record.unit, record }))) !== receipt.targetDigest) {
    throw continuationError('EVIDENCE_STALE', 'correction target changed during verification');
  }
  return proof;
}

export async function resolveExhaustedFailure({ stateRoot, store, unit, request, causeKey, policy, adapters }) {
  const correcting = request?.classification !== undefined;
  const keys = correcting ? 'classification,evidence,expectedRevision,failureId,id,reason' : 'evidence,expectedRevision,failureId,id,reason';
  if (!request || Object.keys(request).sort().join(',') !== keys
    || correcting && !['harness', 'environment'].includes(request.classification)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '')
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.failureId ?? '') || !nonempty(request.reason)
    || !request.evidence || Object.keys(request.evidence).sort().join(',') !== 'digest,ref'
    || !nonempty(request.evidence.ref) || !/^sha256:[a-f0-9]{64}$/.test(request.evidence.digest ?? '')) {
    throw continuationError('RETRY_RESOLUTION_INVALID', 'supply the exact revision, failure, correction evidence and reason');
  }
  const requestDigest = effectArgsDigest({ request, causeKey });
  const record = await store.read(unit);
  const existing = record.retryResolutions?.find(item => item.request.id === request.id);
  if (existing) {
    if (existing.requestDigest !== requestDigest) throw continuationError('RETRY_RESOLUTION_CONFLICT', 'resolution ID has another request');
    await verifyRetryResolution({ stateRoot, record, receipt: existing, adapters });
    const recovery = createRecoveryStore(stateRoot);
    const cause = (await recovery.causes())[causeKey];
    if (!cause?.continuations?.some(item => item.requestDigest === existing.requestDigest && item.failure.unit === unit)) {
      if (effectArgsDigest(cause) !== existing.causeDigest) throw continuationError('RETRY_NOT_ALLOWED', 'cause changed before correction reconciliation');
      await recovery.continueResolved({ causeKey, expected: cause, receipt: existing, apply: async () => {
        const current = await store.read(unit);
        if (current.revision !== record.revision) throw continuationError('STAGE_STALE', 'unit changed while reconciling the verified correction');
      } });
    }
    return { ...existing, duplicate: true };
  }
  if (record.revision !== request.expectedRevision) throw continuationError('STAGE_STALE', 'unit changed before correction verification');
  const captured = correcting && record.gateRecovery
    && ['diagnose', 'ordinary-diagnosis', 'no-progress'].includes(record.gateRecovery.status)
    && record.gateRecovery.failureId === request.failureId;
  const ordinary = captured && record.state === 'SelfGated' && record.gateRecovery.status === 'ordinary-diagnosis';
  if (correcting && !captured) throw continuationError('RETRY_NOT_ALLOWED', 'classification correction requires the original captured gate');
  if (policy.onExhaustion !== 'root-cause' || record.state !== 'Stopped' && !ordinary || record.stopReport
    || !['chore', 'impl', 'impl-risk', 'design'].includes(record.kind)
    || !ordinary && !['Scoped', 'Implementing', 'SelfGated', 'InReview'].includes(record.stoppedFrom)
    || record.sessionFinalization || record.deliveryPlan || record.deliveryResult
    || record.gateRecovery && !captured && record.gateRecovery.status !== 'no-progress'
    || record.accepted || (record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(item => !item.endedAt))) {
    throw continuationError('RETRY_NOT_ALLOWED', 'verified resolution requires the original undelivered exhausted unit and owner');
  }
  const reference = record.failures?.at(-1);
  const bytes = reference?.path === `units/${unit}/failures/${request.failureId}.json`
    && await readFile(path.join(stateRoot, reference.path));
  if (!bytes || hash(bytes) !== reference.digest) throw continuationError('EVIDENCE_STALE', 'the original failure is missing or changed');
  const failure = JSON.parse(bytes);
  const recovery = createRecoveryStore(stateRoot);
  const cause = (await recovery.causes())[causeKey];
  if (failure.id !== request.failureId || failure.causeKey !== causeKey || !['stop', ...(ordinary ? ['diagnose'] : [])].includes(failure.action)
    || !['product', 'harness'].includes(cause?.class) || cause.activeResolver) {
    throw continuationError('RETRY_NOT_ALLOWED', 'the exhausted cause must be confirmed and have no active resolver');
  }
  const diagnosis = attemptsFor(record, 'root-cause').at(-1)?.failureDiagnosis;
  if (diagnosis?.failureId !== failure.id || diagnosis.classification !== (correcting ? request.classification : cause.class)) {
    throw continuationError('DIAGNOSIS_REQUIRED', 'submit a diagnosis for this exhausted cause before correction');
  }
  const receipt = { ...(correcting ? { capturedGate: record.gateRecovery } : {}), request, requestDigest, failure, failureRef: reference, diagnosis, policy, causeDigest: effectArgsDigest(cause),
    policySource: record.policySources?.['retry.onExhaustion'] ?? null,
    policyChange: record.policyChanges?.findLast(item => item.after?.onExhaustion === 'root-cause') ?? null,
    targetDigest: effectArgsDigest(gateTarget(await adapters.git?.inspectUnit({ unit, record }))),
    recordedAt: adapters.now(), revision: record.revision + 1 };
  receipt.proof = await verifyRetryResolution({ stateRoot, record, receipt, adapters });
  await recovery.continueResolved({ causeKey, expected: cause, receipt,
    apply: () => store.update(unit, current => {
      if (current.revision !== record.revision) throw continuationError('STAGE_STALE', 'unit changed during correction verification');
      const updated = { ...current, retryResolutions: [...(current.retryResolutions ?? []), receipt] };
      if (!ordinary) return updated;
      const latest = new Map((current.evidence ?? []).map(item => [item.gate, item]));
      return { ...updated, gateRecovery: null,
        gateRecoveryHistory: [...(current.gateRecoveryHistory ?? []), current.gateRecovery],
        accepted: null, reviewDecision: null, reviewedHead: null, verdict: null,
        evidence: [...(current.evidence ?? []), ...[...latest.values()].map(item => ({ ...item, status: 'stale' }))] };
    }) });
  return receipt;
}
