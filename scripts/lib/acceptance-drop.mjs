import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { correctionSource } from './acceptance-correction.mjs';
import { createLedgerStore } from './ledger.mjs';
import { attemptsFor } from './stage-attempts.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (message, code = 'ACCEPTANCE_DROP_INVALID') => { throw Object.assign(new Error(message), { code }); };

export async function dropAcceptance({ stateRoot, store, unit, request, userInputRef, adapters }) {
  if (!fields(request, ['id', 'expectedRevision', 'acceptanceRef', 'criterionDigest', 'sourceDigest', 'head', 'contentFingerprint', 'provenance', 'reason'])
    || !text(request.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || !text(request.acceptanceRef) || !sha(request.criterionDigest) || !sha(request.sourceDigest)
    || !text(request.head) || !text(request.contentFingerprint) || !text(request.reason) || !text(userInputRef)
    || !fields(request.provenance, ['ref', 'digest']) || !text(request.provenance.ref) || !sha(request.provenance.digest)) {
    fail('drop requires an exact criterion, source, target, provenance, reason and user authorization');
  }
  const requestDigest = effectArgsDigest({ request, userInputRef });
  let receipt;
  const duplicate = new Error('acceptance drop already recorded');
  try {
    await createLedgerStore(stateRoot).withLock(unit, async ledger => {
      const entries = await ledger.read();
      await store.update(unit, async record => {
        const prior = record.acceptanceAmendments?.find(item => item.request.id === request.id);
        if (prior) {
          if (prior.requestDigest !== requestDigest) fail('amendment ID has another payload', 'ACCEPTANCE_DROP_CONFLICT');
          receipt = { ...prior, duplicate: true }; throw duplicate;
        }
        if (record.revision !== request.expectedRevision) fail('unit revision changed', 'ACCEPTANCE_DROP_STALE');
        if (record.state !== 'SelfGated' || ['review', 'ops'].includes(record.kind) || record.accepted
          || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
          || (record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(attempt => !attempt.endedAt))) {
          fail('drop requires a submitted, unaccepted SelfGated change unit', 'INVALID_TRANSITION');
        }
        if (entries.some(entry => {
          if (entry.event !== 'intent') return false;
          const latest = entries.findLast(row => row.event === 'result' && row.seq === entry.seq && row.key === entry.key);
          return !latest || ['unknown', 'uncertain'].includes(latest.result?.status);
        })) fail('reconcile uncertain effects before excluding a criterion', 'EFFECT_UNCERTAIN');
        const source = correctionSource(record);
        const matching = record.acceptance?.filter(item => item.id === request.acceptanceRef) ?? [];
        if (matching.length !== 1 || ['deferred', 'dropped'].includes(matching[0].status)
          || effectArgsDigest(matching[0]) !== request.criterionDigest || effectArgsDigest(source) !== request.sourceDigest) {
          fail('criterion or original scope changed', 'ACCEPTANCE_DROP_STALE');
        }
        if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.provider?.verifyAcceptanceChange !== 'function') {
          fail('drop requires trusted Git and user scope-change verification', 'ADAPTER_MISSING');
        }
        const target = await adapters.git.inspectUnit({ unit, record });
        if (target?.head !== request.head || target?.contentFingerprint !== request.contentFingerprint) fail('drop target changed', 'ACCEPTANCE_DROP_STALE');
        const binding = { unit, userInputRef, operation: 'drop', argsDigest: requestDigest, sourceDigest: request.sourceDigest,
          head: request.head, contentFingerprint: request.contentFingerprint, targetDigest: effectArgsDigest(target) };
        await verifyApprovalInput(adapters.provider, { ...binding, effect: 'unit.acceptance.drop', reason: request.reason });
        const verified = await adapters.provider.verifyAcceptanceChange({ ...binding,
          request: structuredClone(request), source: structuredClone(source), target: structuredClone(target) });
        if (verified?.verified !== true || Object.entries(binding).some(([key, value]) => verified[key] !== value)) {
          fail('actual user instruction does not verify the exact criterion exclusion', 'ACCEPTANCE_DROP_UNPROVEN');
        }
        if (effectArgsDigest(await adapters.git.inspectUnit({ unit, record }) ?? null) !== effectArgsDigest(target)) fail('target changed during verification', 'ACCEPTANCE_DROP_STALE');
        const before = matching[0], after = { ...before, status: 'dropped' };
        receipt = { request, userInputRef, requestDigest, beforeSource: source, before, after,
          previousReview: { reviewDecision: record.reviewDecision ?? null, reviewedHead: record.reviewedHead ?? null, verdict: record.verdict ?? null },
          revision: record.revision + 1, changedAt: adapters.now() };
        const latest = new Map((record.evidence ?? []).filter(item => item?.gate).map(item => [item.gate, item]));
        return { ...record, acceptance: record.acceptance.map(item => item.id === request.acceptanceRef ? after : item),
          acceptanceAmendments: [...(record.acceptanceAmendments ?? []), receipt],
          evidence: [...(record.evidence ?? []), ...[...latest.values()].map(item => ({ ...item, status: 'stale', covers: [], invalidatedBy: request.id }))],
          accepted: null, reviewDecision: null, reviewedHead: null, verdict: null, diff: null, handoff: null };
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
