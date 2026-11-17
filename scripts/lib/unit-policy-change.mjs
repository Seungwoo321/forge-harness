import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';
import { resolvePolicy } from './policy.mjs';
import { transitionRecord } from './unit-state.mjs';
import { attemptsFor } from './stage-attempts.mjs';
import { assertDeliveryObligations } from './acceptance-correction.mjs';

const deliveries = new Set(['none', 'commit', 'push', 'pr', 'merge']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['.', '..'].includes(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

export async function changeUnitPolicy({ stateRoot, store, unit, request, userInputRef, adapters }) {
  const field = request && Object.hasOwn(request, 'delivery') ? 'delivery'
    : request && Object.hasOwn(request, 'retry') ? 'retry' : 'review';
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== [field,'expectedRevision','id','reason'].sort().join(',')
    || !identifier(request.id) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || (field === 'delivery' ? !deliveries.has(request.delivery) : field === 'retry'
      ? !request.retry || Object.keys(request.retry).join(',') !== 'onExhaustion' || !['stop', 'root-cause'].includes(request.retry.onExhaustion)
      : !request.review || typeof request.review !== 'object' || Array.isArray(request.review)
      || Object.keys(request.review).sort().join(',') !== 'by,mode,triggers')
    || typeof request.reason !== 'string' || !request.reason.trim()
    || typeof userInputRef !== 'string' || !userInputRef.trim()) throw failure('POLICY_CHANGE_INVALID', 'exact delivery, review or exhaustion policy, revision, reason and user authorization are required');
  const requestDigest = effectArgsDigest({ request, userInputRef });
  const ledgerStore = createLedgerStore(stateRoot);
  let receipt;
  const duplicate = new Error('policy change already recorded');
  try {
    await ledgerStore.withLock(unit, async ledger => {
      const entries = await ledger.read();
      await store.update(unit, async record => {
        const existing = (record.policyChanges ?? []).find(item => item.id === request.id);
        if (existing) {
          if (existing.requestDigest !== requestDigest) throw failure('POLICY_CHANGE_CONFLICT', 'policy change ID already has a different request');
          receipt = { ...existing, duplicate: true }; throw duplicate;
        }
        if (record.revision !== request.expectedRevision) throw failure('POLICY_CHANGE_STALE', 'unit revision changed');
        const states = field === 'retry' ? ['Implementing', 'SelfGated', 'Accepted', 'Stopped'] : ['SelfGated', 'Accepted'];
        if (!states.includes(record.state) || ['review', 'ops'].includes(record.kind)
          || field === 'retry' && record.state === 'Stopped' && record.stopReport
          || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
          || (record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(attempt => !attempt.endedAt))) {
          throw failure('INVALID_TRANSITION', 'policy changes require a submitted, undelivered unit with no session finalization');
        }
        if (entries.some(entry => {
          if (entry.event !== 'intent' || sessionEffectRetired(entries,entry)) return false;
          const latest = entries.findLast(row => row.event === 'result' && row.seq === entry.seq && row.key === entry.key);
          return !latest || ['unknown', 'uncertain'].includes(latest.result?.status);
        })) {
          throw failure('EFFECT_UNCERTAIN', 'reconcile uncertain effects before changing policy');
        }
        const before = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true }).policy;
        const overrides = { ...(record.policyOverrides ?? {}),
          [field]: field === 'retry' ? { ...record.policyOverrides?.retry, ...request.retry } : request[field] };
        let after;
        try { after = resolvePolicy({ unit: overrides, project: record.policy ?? {} }, { nonInteractive: true }).policy; }
        catch (error) { throw failure('POLICY_CHANGE_INVALID', `invalid ${field} policy: ${error.message}`); }
        if (effectArgsDigest(before[field]) === effectArgsDigest(after[field])) throw failure('POLICY_CHANGE_INVALID', `${field} is already set to the requested value`);
        assertDeliveryObligations(record, after.delivery, {allowIncomplete:true});
        await verifyApprovalInput(adapters.provider, { unit, userInputRef, effect: 'unit.policy.change', argsDigest: requestDigest,
          before: field === 'delivery' ? before.delivery : JSON.stringify(before[field]),
          after: field === 'delivery' ? after.delivery : JSON.stringify(after[field]), reason: request.reason });
        const changedAt = adapters.now();
        receipt = { ...request, unit, requestDigest, userInputRef, before: before[field], after: after[field],
          previousPolicy: before, previousPolicySources: record.policySources ?? {}, previousAcceptance: record.accepted ?? null, previousReviewDecision: record.reviewDecision ?? null,
          changedAt, revision: record.revision + 1 };
        // A delivery change does not alter the reviewed content: keep the independent review bound to its head and
        // fingerprint so re-acceptance can reuse it. A review policy change invalidates the prior review decision.
        const reviewState = field === 'review' ? { reviewDecision: null, reviewedHead: null, verdict: null } : {};
        const updated = { ...record, policyOverrides: overrides,
          ...(field === 'retry' ? { policySources: { ...record.policySources, 'retry.onExhaustion': 'unit' } } : {}),
          policyChanges: [...(record.policyChanges ?? []), receipt],
          accepted: null, ...reviewState };
        return record.state === 'Accepted' ? transitionRecord(updated, 'SelfGated') : updated;
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}

// Correct only the authority attribution; retain the original change and every execution result.
export async function correctPolicyApproval({ stateRoot, store, unit, request, userInputRef, adapters }) {
  const invalid = message => failure('POLICY_APPROVAL_CORRECTION_INVALID', message);
  if (!request || Object.keys(request).sort().join(',') !== 'change,expectedRevision,id,reason'
    || !identifier(request.id) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || Object.keys(request.change ?? {}).sort().join(',') !== 'digest,index'
    || !Number.isSafeInteger(request.change.index) || request.change.index < 0
    || !/^sha256:[a-f0-9]{64}$/.test(request.change.digest ?? '')
    || typeof request.reason !== 'string' || !request.reason.trim()
    || typeof userInputRef !== 'string' || !userInputRef.trim()) throw invalid('exact change, revision, reason and original human input are required');
  if (typeof adapters.git?.inspectUnit !== 'function') throw failure('ADAPTER_MISSING', 'live target inspection is required');
  const requestDigest = effectArgsDigest({ request, userInputRef });
  const duplicate = new Error('policy approval already corrected');
  let receipt;
  try {
    await createLedgerStore(stateRoot).withLock(unit, async ledger => {
      const rows = await ledger.read();
      await store.update(unit, async record => {
        const previous = (record.policyApprovalCorrections ?? []).find(item => item.id === request.id);
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw invalid('correction id binds another request');
          receipt = { ...previous, duplicate: true }; throw duplicate;
        }
        if (record.revision !== request.expectedRevision || !['SelfGated', 'InReview'].includes(record.state)
          || ['review', 'ops'].includes(record.kind) || record.accepted || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
          || (record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(attempt => !attempt.endedAt))) {
          throw failure('POLICY_APPROVAL_CORRECTION_STALE', 'correction requires the current submitted, unaccepted and undelivered change unit');
        }
        const original = record.policyChanges?.[request.change.index];
        const effective = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true }).policy;
        if (!original || request.change.index !== record.policyChanges.length - 1 || effectArgsDigest(original) !== request.change.digest
          || original.unit !== unit || original.previousPolicy?.delivery !== original.before
          || !identifier(original.id) || !Number.isSafeInteger(original.expectedRevision) || original.expectedRevision < 1
          || original.revision !== original.expectedRevision + 1 || original.revision > record.revision
          || original.requestDigest !== effectArgsDigest({ request: { id: original.id, expectedRevision: original.expectedRevision,
            delivery: original.delivery, reason: original.reason }, userInputRef: original.userInputRef })
          || original.userInputRef === userInputRef || !deliveries.has(original.before) || !deliveries.has(original.after)
          || original.delivery !== original.after || original.before === original.after || effective.delivery !== original.after
          || (record.policyApprovalCorrections ?? []).some(item => item.request.change.index === request.change.index)) {
          throw invalid('the latest delivery change or approval no longer matches');
        }
        if (rows.some(row => {
          if (row.event !== 'intent' || sessionEffectRetired(rows, row)) return false;
          const result = rows.findLast(done => done.event === 'result' && done.seq === row.seq && done.key === row.key);
          return !result || ['unknown', 'uncertain'].includes(result.result?.status);
        })) throw failure('EFFECT_UNCERTAIN', 'reconcile uncertain effects first');
        const target = structuredClone(await adapters.git.inspectUnit({ unit, record }));
        if (!target?.head || !target.contentFingerprint) throw invalid('current target is unavailable');
        const targetDigest = effectArgsDigest(target);
        await verifyApprovalInput(adapters.provider, { unit, userInputRef, effect: 'unit.policy.approval.correct', argsDigest: requestDigest,
          unitDigest: effectArgsDigest(record), policyChangeDigest: request.change.digest, previousUserInputRef: original.userInputRef,
          targetDigest, reason: request.reason });
        if (effectArgsDigest(await adapters.git.inspectUnit({ unit, record })) !== targetDigest) {
          throw failure('POLICY_APPROVAL_CORRECTION_STALE', 'target changed during approval verification');
        }
        receipt = { id: request.id, request: structuredClone(request), requestDigest, userInputRef, original: structuredClone(original),
          target: structuredClone(target), targetDigest, revision: record.revision + 1, correctedAt: adapters.now() };
        return { ...record, policyApprovalCorrections: [...(record.policyApprovalCorrections ?? []), receipt] };
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
