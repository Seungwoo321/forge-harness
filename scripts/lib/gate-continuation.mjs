import { attemptsFor } from './stage-attempts.mjs';
import { transitionRecord } from './unit-state.mjs';

export const continuationError = (code, message) => Object.assign(new Error(message), { code });

export function gateTarget(target) {
  if (!target?.head || !target.contentFingerprint) throw continuationError('ADAPTER_MISSING', 'gate continuation requires a Git target observation');
  return { head: target.head, contentFingerprint: target.contentFingerprint };
}

export function sameGateTarget(left, right) {
  return left?.head === right?.head && left?.contentFingerprint === right?.contentFingerprint;
}

export function productGateFailure(evidence) {
  return evidence?.status === 'failed' && evidence.execution?.kind === 'isolated-snapshot-v1'
    && evidence.execution.fingerprint === evidence.fingerprint
    && (evidence.failureClass === 'product' || evidence.failureClass === 'unknown' && evidence.testCases?.some(item => !item.passed));
}

export function measuredGateProgress(baseline, result) {
  if (!productGateFailure(result) || !baseline.testCases?.length || !result.testCases?.length) return false;
  const old = new Map(baseline.testCases.map(item => [JSON.stringify(item.path), item.passed]));
  const next = new Map(result.testCases.map(item => [JSON.stringify(item.path), item.passed]));
  if (old.size !== baseline.testCases.length || next.size !== result.testCases.length) return false;
  const failed = [...old].filter(([, passed]) => !passed);
  return failed.every(([name]) => next.has(name)) && failed.some(([name]) => next.get(name) === true)
    && [...next].every(([name, passed]) => passed || old.get(name) === false);
}

export function gateRepairPassed(diagnosedCases, result) {
  if (result.status !== 'passed' || result.nondeterministic || result.exit !== 0 || result.failureClass != null) return false;
  return diagnosedCases.filter(item => !item.passed)
    .every(item => result.testCases?.filter(test => test.passed && JSON.stringify(test.path) === JSON.stringify(item.path)).length === 1);
}

export function beginGateRepair(record, { causeKey, target, policy, startedAt }) {
  const recovery = record.gateRecovery;
  const ordinary = record.state === 'SelfGated' && recovery.status === 'ordinary-diagnosis';
  const exhausted = record.state === 'Stopped' && record.stoppedFrom === 'SelfGated' && recovery.status === 'diagnose';
  if ((!ordinary && !exhausted) || record.stopReport
    || record.sessionFinalization || record.deliveryPlan || record.deliveryResult || record.accepted
    || recovery.causeKey !== causeKey
    || policy.onExhaustion !== 'root-cause') {
    throw continuationError('RETRY_NOT_ALLOWED', 'no authorized same-unit gate repair is available');
  }
  const diagnosis = attemptsFor(record, 'root-cause').at(-1)?.gateDiagnosis;
  if (diagnosis?.failureId !== recovery.failureId) {
    throw continuationError('DIAGNOSIS_REQUIRED', 'submit a product diagnosis for the current exhausted failure');
  }
  if (!sameGateTarget(recovery.baseline.target, target)) {
    throw continuationError('STAGE_STALE', 'restore the diagnosed failure target before opening the repair');
  }
  const feedback = [...(record.feedback ?? []), { kind: 'gate-diagnosis', ...diagnosis }];
  if (ordinary) return transitionRecord({ ...record, gateRecovery: null, feedback }, 'Implementing');
  const receipt = { failure: recovery.failure, failureId: recovery.failureId, causeKey,
    gate: recovery.baseline.gate, baseline: recovery.baseline, diagnosis,
    policy: { retry: policy, source: record.policySources?.['retry.onExhaustion'] ?? null,
      change: record.policyChanges?.findLast(item => item.after?.onExhaustion === 'root-cause') ?? null },
    startedAt, revision: record.revision + 1 };
  const resumed = transitionRecord(record, 'SelfGated');
  return transitionRecord({ ...resumed, feedback, gateRecovery: { ...recovery, status: 'repair' },
    retryContinuations: [...(record.retryContinuations ?? []), receipt] }, 'Implementing');
}
