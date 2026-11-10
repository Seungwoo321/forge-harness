import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createLedgerStore, sessionStartRetired } from './ledger.mjs';
import { attemptsFor } from './stage-attempts.mjs';
import { resolvePolicy } from './policy.mjs';
import { bindDeliveryCommit, validateAcceptedContent } from './delivery.mjs';

const levels = ['none', 'commit', 'push', 'pr', 'merge'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const reference = value => fields(value, ['ref', 'digest']) && text(value.ref) && sha(value.digest);
const fail = (message, code = 'ACCEPTANCE_CORRECTION_INVALID') => { throw Object.assign(new Error(message), { code }); };

export function correctionSource(record) {
  return { request: record.request, canon: record.canon ?? [], acceptance: record.acceptance ?? [] };
}

function assertRequest(request, userInputRef) {
  const keys = ['id', 'expectedRevision', 'acceptanceRef', 'criterionDigest', 'sourceDigest', 'head', 'contentFingerprint', 'kind', 'provenance', 'reason'];
  if (!fields(request, [...keys, ...(request?.kind === 'observation' ? ['evidence'] : ['level', 'owner'])])
    || !text(request.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id) || request.id === '..'
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || !text(request.acceptanceRef) || !sha(request.criterionDigest) || !sha(request.sourceDigest)
    || !text(request.head) || !text(request.contentFingerprint) || !text(request.reason) || !text(userInputRef)
    || !reference(request.provenance)
    || (request.kind === 'observation' ? !reference(request.evidence)
      : request.kind !== 'delivery' || !levels.slice(1).includes(request.level) || !['engine', 'external'].includes(request.owner))) {
    fail('correction requires an exact criterion, source, target, provenance, reason and observation evidence or delivery level');
  }
}

export function currentCorrections(record) {
  return [...new Map((record.acceptanceCorrections ?? []).map(receipt => [receipt.request.acceptanceRef, receipt])).values()]
    .filter(receipt => !(record.acceptance ?? []).some(item => item.id === receipt.request.acceptanceRef && item.status === 'dropped'));
}

export function productAcceptance(record) {
  const corrected = new Set(currentCorrections(record).map(receipt => receipt.request.acceptanceRef));
  return (record.acceptance ?? []).filter(item => item.status !== 'dropped' && !corrected.has(item.id));
}

export function assertDeliveryObligations(record, delivery) {
  for (const { request } of currentCorrections(record)) {
    if (request.kind === 'delivery' && request.owner === 'engine' && (!levels.includes(delivery) || levels.indexOf(delivery) < levels.indexOf(request.level))) {
      fail(`delivery must satisfy ${request.acceptanceRef}: ${request.level}`, 'DELIVERY_OBLIGATION_REQUIRED');
    }
  }
}

export function externalDeliveryObligations(record) {
  return currentCorrections(record).filter(({ request }) => request.kind === 'delivery' && request.owner === 'external');
}

// External execution stays outside the effect ledger. Only independently observed, accepted content can finish.
export async function verifyExternalDeliveryBoundary({ store, unit, adapters }) {
  const record = await store.read(unit);
  if (!externalDeliveryObligations(record).length || !['Accepted', 'Delivering', 'Delivered'].includes(record.state)) return record;
  return store.update(unit, async current => {
    const obligations = externalDeliveryObligations(current);
    if (!current.accepted || !['Accepted', 'Delivering', 'Delivered'].includes(current.state)) fail('external delivery requires a current accepted target', 'INVALID_TRANSITION');
    if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.provider?.verifyExternalDelivery !== 'function') {
      fail('external delivery requires trusted read-only Git and evidence verification', 'ADAPTER_MISSING');
    }
    const target = await adapters.git.inspectUnit({ unit, record: current });
    await verifyAcceptanceCorrections(current, adapters, target);
    const before = current.accepted;
    const metadata = ['repo', 'branch', 'base', 'tree'];
    if (metadata.some(field => !text(before[field]) || target?.[field] !== before[field])
      || target?.headTree !== before.tree || target?.indexTree !== before.tree
      || target?.head === before.head && target.headTree !== before.headTree
      || target?.contentFingerprint !== before.contentFingerprint) fail('external delivery target differs from acceptance', 'EXTERNAL_DELIVERY_UNPROVEN');
    let accepted = { ...before, indexTree: target.indexTree, headTree: target.headTree };
    if (target.head !== before.head) {
      if (target.headParent !== before.head || target.headTree !== before.tree || target.indexTree !== before.tree
        || current.deliveryResult && current.deliveryResult.level !== 'none') {
        fail('external commit does not preserve the accepted parent and tree', 'EXTERNAL_DELIVERY_UNPROVEN');
      }
      const bound = bindDeliveryCommit(before, before, { sha: target.head, parent: target.headParent, tree: target.tree, contentFingerprint: target.contentFingerprint });
      if (!bound.valid) fail('external commit content differs from acceptance', 'EXTERNAL_DELIVERY_UNPROVEN');
      accepted = { ...bound.accepted, indexTree: target.indexTree, headTree: target.headTree };
    }
    if (!validateAcceptedContent(accepted, target).valid) fail('external delivery target is stale', 'EXTERNAL_DELIVERY_UNPROVEN');
    const receipts = [];
    for (const correction of obligations) {
      const binding = { unit, acceptanceRef: correction.request.acceptanceRef, correctionDigest: correction.requestDigest,
        sourceDigest: correction.request.sourceDigest, acceptedDigest: effectArgsDigest(before), targetDigest: effectArgsDigest(target) };
      const proof = await adapters.provider.verifyExternalDelivery({ ...binding, request: structuredClone(correction.request),
        source: structuredClone(correctionSource(current)), accepted: structuredClone(before), target: structuredClone(target) });
      const delivery = proof?.delivery;
      if (proof?.verified !== true || Object.entries(binding).some(([key, value]) => proof[key] !== value)
        || !reference(proof.evidence) || !delivery || !levels.includes(delivery.level) || levels.indexOf(delivery.level) < levels.indexOf(correction.request.level)
        || ['repo', 'branch', 'base', 'head', 'contentFingerprint'].some(field => delivery[field] !== target[field])
        || levels.indexOf(correction.request.level) >= levels.indexOf('pr') && (!text(delivery.pr) || !['open', 'merged'].includes(delivery.status))
        || correction.request.level === 'merge' && (delivery.status !== 'merged' || !text(delivery.mergeHead))) {
        fail('bound external delivery evidence is missing, stale or unverified', 'EXTERNAL_DELIVERY_UNPROVEN');
      }
      const verified = { ...binding, evidence: structuredClone(proof.evidence), delivery: structuredClone(delivery), beforeAccepted: before, accepted };
      receipts.push({ ...verified, digest: effectArgsDigest(verified), verifiedAt: adapters.now() });
    }
    if (effectArgsDigest(await adapters.git.inspectUnit({ unit, record: current })) !== effectArgsDigest(target)) {
      fail('external delivery target changed during verification', 'EXTERNAL_DELIVERY_UNPROVEN');
    }
    const history = [...(current.externalDeliveryEvidence ?? [])];
    for (const receipt of receipts) if (!history.some(item => item.digest === receipt.digest)) history.push(receipt);
    return { ...current, head: accepted.head, accepted, externalDeliveryEvidence: history,
      ...(current.deliveryResult?.level === 'none' ? { deliveryResult: { ...current.deliveryResult, head: accepted.head } } : {}) };
  });
}

// Only this gate tests the product criteria projection. Review and the canonical record keep every original obligation.
export async function describeAcceptanceGate(adapters, id, unit, record) {
  const amended = record.acceptanceAmendments?.length > 0;
  const project = id === 'acceptance-coverage' && (record.acceptanceCorrections?.length > 0 || amended);
  const described = project ? { ...record, acceptance: productAcceptance(record), acceptanceObligations: record.acceptance } : record;
  const gate = await adapters.gates.describe(id, { unit, record: described });
  if (!gate || !project && !amended) return gate;
  return { ...gate, config: { ...gate.config,
    ...(project ? { acceptanceVerification: effectArgsDigest({ acceptance: record.acceptance, corrections: record.acceptanceCorrections ?? [] }) } : {}),
    ...(amended ? { acceptanceScope: effectArgsDigest({ acceptance: record.acceptance, amendments: record.acceptanceAmendments }) } : {}),
  } };
}

async function verifyCorrection(record, receipt, adapters, target) {
  const { request, userInputRef, requestDigest } = receipt;
  assertRequest(request, userInputRef);
  const criteria = (record.acceptance ?? []).filter(item => item.id === request.acceptanceRef);
  const source = correctionSource(record);
  if (criteria.length !== 1 || ['deferred', 'dropped'].includes(criteria[0].status)
    || effectArgsDigest(criteria[0]) !== request.criterionDigest || effectArgsDigest(source) !== request.sourceDigest
    || effectArgsDigest({ request, userInputRef }) !== requestDigest
    || target?.contentFingerprint !== request.contentFingerprint
    || target?.head !== request.head && !(record.accepted?.validatedHead === request.head
      && record.accepted.contentFingerprint === request.contentFingerprint)) {
    fail('criterion, authority or target changed since correction', 'ACCEPTANCE_CORRECTION_STALE');
  }
  const binding = { unit: record.unit, userInputRef, argsDigest: requestDigest, sourceDigest: request.sourceDigest,
    head: request.head, currentHead: target.head, contentFingerprint: request.contentFingerprint, targetDigest: effectArgsDigest(target) };
  await verifyApprovalInput(adapters.provider, { ...binding, effect: 'unit.acceptance.correct', reason: request.reason });
  if (typeof adapters.provider?.verifyAcceptanceCorrection !== 'function') fail('a trusted acceptance correction verifier is required', 'ADAPTER_MISSING');
  const verified = await adapters.provider.verifyAcceptanceCorrection({ ...binding, request: structuredClone(request), source: structuredClone(source), target: structuredClone(target) });
  if (verified?.verified !== true || Object.entries(binding).some(([key, value]) => verified[key] !== value)) {
    fail('original authority, recording mismatch or operational evidence is unverified', 'ACCEPTANCE_CORRECTION_UNPROVEN');
  }
}

export async function verifyAcceptanceCorrections(record, adapters, target) {
  for (const receipt of currentCorrections(record)) await verifyCorrection(record, receipt, adapters, target);
}

export async function correctAcceptance({ stateRoot, store, unit, request, userInputRef, adapters }) {
  assertRequest(request, userInputRef);
  const requestDigest = effectArgsDigest({ request, userInputRef });
  let receipt;
  const duplicate = new Error('correction already recorded');
  try {
    await createLedgerStore(stateRoot).withLock(unit, async ledger => {
      const entries = await ledger.read();
      await store.update(unit, async record => {
        const existing = record.acceptanceCorrections?.find(item => item.request.id === request.id);
        if (existing) {
          if (existing.requestDigest !== requestDigest) fail('correction ID has a different payload', 'ACCEPTANCE_CORRECTION_CONFLICT');
          receipt = { ...existing, duplicate: true }; throw duplicate;
        }
        if (record.revision !== request.expectedRevision) fail('unit revision changed', 'ACCEPTANCE_CORRECTION_STALE');
        if (record.state !== 'SelfGated' || ['review', 'ops'].includes(record.kind) || record.accepted
          || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
          || (record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(attempt => !attempt.endedAt))) {
          fail('correction requires a submitted, unaccepted SelfGated change unit', 'INVALID_TRANSITION');
        }
        if (entries.some(entry => {
          if (entry.event !== 'intent' || sessionStartRetired(entries,entry)) return false;
          const latest = entries.findLast(row => row.event === 'result' && row.seq === entry.seq && row.key === entry.key);
          return !latest || ['unknown', 'uncertain'].includes(latest.result?.status);
        })) fail('reconcile uncertain effects before correction', 'EFFECT_UNCERTAIN');
        const previous = currentCorrections(record).find(item => item.request.acceptanceRef === request.acceptanceRef);
        if (previous && (previous.request.kind !== request.kind || previous.request.owner !== request.owner
          || request.kind === 'delivery' && levels.indexOf(request.level) < levels.indexOf(previous.request.level))) {
          fail('a correction cannot change a classification or weaken a delivery obligation');
        }
        if (typeof adapters.git?.inspectUnit !== 'function') fail('correction requires Git inspection', 'ADAPTER_MISSING');
        receipt = { request, userInputRef, requestDigest, revision: record.revision + 1, correctedAt: adapters.now(),
          previousReview: { reviewDecision: record.reviewDecision ?? null, reviewedHead: record.reviewedHead ?? null, verdict: record.verdict ?? null } };
        const target = await adapters.git.inspectUnit({ unit, record });
        await verifyCorrection(record, receipt, adapters, target);
        const updated = { ...record, acceptanceCorrections: [...(record.acceptanceCorrections ?? []), receipt],
          reviewDecision: null, reviewedHead: null, verdict: null, diff: null, handoff: null };
        const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
        assertDeliveryObligations(updated, policy.delivery);
        const checked = await adapters.git.inspectUnit({ unit, record });
        if (effectArgsDigest(checked ?? null) !== effectArgsDigest(target)) fail('target changed during correction', 'ACCEPTANCE_CORRECTION_STALE');
        return updated;
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
