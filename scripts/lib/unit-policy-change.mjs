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
  const field = request && Object.hasOwn(request, 'delivery') ? 'delivery' : 'review';
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== [field,'expectedRevision','id','reason'].sort().join(',')
    || !identifier(request.id) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || (field === 'delivery' ? !deliveries.has(request.delivery) : !request.review || typeof request.review !== 'object' || Array.isArray(request.review)
      || Object.keys(request.review).sort().join(',') !== 'by,mode,triggers')
    || typeof request.reason !== 'string' || !request.reason.trim()
    || typeof userInputRef !== 'string' || !userInputRef.trim()) throw failure('POLICY_CHANGE_INVALID', 'exact delivery or review policy, revision, reason and user authorization are required');
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
        if (!['SelfGated', 'Accepted'].includes(record.state) || ['review', 'ops'].includes(record.kind)
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
        const overrides = { ...(record.policyOverrides ?? {}), [field]: request[field] };
        let after;
        try { after = resolvePolicy({ unit: overrides, project: record.policy ?? {} }, { nonInteractive: true }).policy; }
        catch (error) { throw failure('POLICY_CHANGE_INVALID', `invalid ${field} policy: ${error.message}`); }
        if (effectArgsDigest(before[field]) === effectArgsDigest(after[field])) throw failure('POLICY_CHANGE_INVALID', `${field} is already set to the requested value`);
        assertDeliveryObligations(record, after.delivery, {allowIncomplete:true});
        await verifyApprovalInput(adapters.provider, { unit, userInputRef, effect: 'unit.policy.change', argsDigest: requestDigest,
          before: field === 'review' ? JSON.stringify(before.review) : before.delivery,
          after: field === 'review' ? JSON.stringify(after.review) : after.delivery, reason: request.reason });
        const changedAt = adapters.now();
        receipt = { ...request, unit, requestDigest, userInputRef, before: before[field], after: after[field],
          previousPolicy: before, previousAcceptance: record.accepted ?? null, previousReviewDecision: record.reviewDecision ?? null,
          changedAt, revision: record.revision + 1 };
        // A delivery change does not alter the reviewed content: keep the independent review bound to its head and
        // fingerprint so re-acceptance can reuse it. A review policy change invalidates the prior review decision.
        const reviewState = field === 'delivery' ? {} : { reviewDecision: null, reviewedHead: null, verdict: null };
        const updated = { ...record, policyOverrides: overrides, policyChanges: [...(record.policyChanges ?? []), receipt],
          accepted: null, ...reviewState };
        return record.state === 'Accepted' ? transitionRecord(updated, 'SelfGated') : updated;
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
