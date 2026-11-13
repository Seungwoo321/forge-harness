import { prepareEffect } from './policy.mjs';
import { withGoalAcceptanceRecoveryLock } from './goal-acceptance-lock.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { acquireContinuityLock } from './continuity-lock.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';
import { assertReviewsSettled, assertAdoptedOwner, goalOwner } from './continuity-custody.mjs';
import { validateAcceptedContent } from './delivery.mjs';
import { acceptanceCoverage, hasInvalidEvidence, evaluateAcceptance } from './evidence.mjs';
import { productAcceptance, currentCorrections, correctionSource, verifyAcceptanceCorrections } from './acceptance-correction.mjs';
import { selectProfile } from './profile.mjs';

const fail = (message, code = 'GOAL_ACCEPTANCE_INVALID') => { throw Object.assign(new Error(message), { code }); };
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const fields = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const active = entry => !['deferred', 'dropped'].includes(entry.status);
const definition = goal => ({ id: goal.goal.id, objective: goal.goal.objective, criteria: goal.goal.criteria, source: goal.source });

// Lifecycle metadata can advance without changing the obligations and accepted product provenance.
export function goalAcceptanceBasis(record) {
  const accepted = record.accepted ? { ...record.accepted, head: record.accepted.validatedHead ?? record.accepted.head } : null;
  if (accepted) {
    delete accepted.validatedHead;
    // The existing delivery binder retains the validated parent and content while advancing Git metadata.
    if (accepted.tree) { delete accepted.indexTree; delete accepted.headTree; }
  }
  return { ...Object.fromEntries(['request', 'canon', 'acceptance', 'acceptanceCorrections', 'evidence',
    'reviewDecision', 'reviewedHead', 'verdict', 'policy', 'policyOverrides'].map(key => [key, record[key] ?? null])), accepted };
}

function assertMappings(mappings, goal, record) {
  if (!Array.isArray(mappings) || mappings.length !== goal.goal.criteria.length
    || new Set(mappings.map(item => item?.criterion)).size !== mappings.length) fail('every original goal criterion requires one explicit mapping');
  for (const mapping of mappings) {
    if (!fields(mapping, ['criterion', 'acceptanceRefs', 'evidence']) || !goal.goal.criteria.includes(mapping.criterion)
      || !Array.isArray(mapping.evidence) || !mapping.evidence.length || mapping.evidence.some(item => !fields(item, ['ref', 'digest'])
        || typeof item.ref !== 'string' || !item.ref.trim() || !sha(item.digest))
      || !Array.isArray(mapping.acceptanceRefs) || !mapping.acceptanceRefs.length
      || new Set(mapping.acceptanceRefs).size !== mapping.acceptanceRefs.length
      || mapping.acceptanceRefs.some(ref => typeof ref !== 'string' || record.acceptance?.filter(item => item.id === ref && active(item)).length !== 1))
      fail('mapping must reference unchanged, active acceptance criteria');
  }
}

export function clarifiedGoalReferences(record, goal, criterion) {
  const receipt = record.goalAcceptanceClarifications?.at(-1);
  if (!receipt) return null;
  const { request, userInputRef } = receipt;
  if (effectArgsDigest({ request, userInputRef }) !== receipt.requestDigest
    || effectArgsDigest(definition(goal)) !== receipt.definitionDigest
    || effectArgsDigest(goalAcceptanceBasis(record)) !== receipt.basisDigest) fail('clarification source or accepted obligations changed', 'GOAL_ACCEPTANCE_STALE');
  assertMappings(request.mappings, goal, record);
  return request.mappings.find(item => item.criterion === criterion)?.acceptanceRefs ?? null;
}

export function hasGoalReferenceEvidence(record, ref, goal, coverage) {
  const criterion = record.acceptance?.find(entry => entry.id === ref);
  if (!criterion || !active(criterion)) return false;
  const correction = currentCorrections(record).find(receipt => receipt.request.acceptanceRef === ref);
  return coverage.covered.includes(ref) || Boolean(correction
    && effectArgsDigest(correctionSource(record, correction, goal)) === correction.request.sourceDigest
    && effectArgsDigest(criterion) === correction.request.criterionDigest
    && effectArgsDigest({ request: correction.request, userInputRef: correction.userInputRef }) === correction.requestDigest);
}

async function verifySource(source) {
  if (!path.isAbsolute(source?.path ?? '') || !sha(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest)
    fail('original goal source changed', 'GOAL_ACCEPTANCE_STALE');
}

export async function verifyNativeCustody(record, goal, adapters) {
  const owner = goalOwner(goal, record.unit);
  if (!owner || typeof adapters.session?.observe !== 'function') fail('current native custody observation is required', 'ADAPTER_MISSING');
  const observed = await adapters.session.observe({ cwd: owner.cwd, targetCwd: owner.cwd });
  if (observed.sessionId !== owner.sessionId || observed.incarnationId !== owner.incarnationId || observed.cwd !== owner.cwd
    || owner.nativeThreadId && observed.worker?.threadId !== owner.nativeThreadId) fail('native owner changed', 'SESSION_OWNER_MISMATCH');
  assertAdoptedOwner(owner, observed);
  return observed;
}

async function verifyClarificationCustody({ record, goal, stateRoot, adapters, closingArgs }) {
  const plan = record.sessionFinalization, owner = goalOwner(goal, record.unit);
  if (closingArgs && record.state === 'Delivered' && plan && !plan.retainedOwner
    && ['sessionId', 'incarnationId', 'cwd'].every(key => owner?.[key] === plan.owner?.[key])
    && effectArgsDigest(closingArgs.owner) === effectArgsDigest(plan.owner)
    && effectArgsDigest(closingArgs.recipient) === effectArgsDigest(plan.recipient)
    && closingArgs.resultDigest === plan.resultDigest && closingArgs.session === plan.owner.sessionId
    && closingArgs.incarnation === plan.owner.incarnationId && typeof adapters.session?.verify === 'function') {
    const key = prepareEffect('session.close', closingArgs).key;
    const rows = await createLedgerStore(stateRoot).withLock(record.unit, ledger => ledger.read());
    const intent = rows.findLast(row => row.event === 'intent' && row.unit === record.unit && row.effect === 'session.close'
      && row.key === key && effectArgsDigest(row.args) === effectArgsDigest(closingArgs));
    if (intent) {
      const observed = await adapters.session.verify({ unit: record.unit, effect: 'session.close', args: closingArgs, key, seq: intent.seq, reconcileOnly: true });
      const result = observed?.result;
      if (observed?.status === 'completed' && result?.closed === true && result.sessionId === plan.owner.sessionId && result.incarnationId === plan.owner.incarnationId)
        return { key, seq: intent.seq, intentDigest: effectArgsDigest(intent), ownerDigest: effectArgsDigest(plan.owner),
          result: { closed: true, sessionId: result.sessionId, incarnationId: result.incarnationId } };
    }
  }
  await verifyNativeCustody(record, goal, adapters);
  return null;
}

async function verifyClarification(record, goal, receipt, adapters, target, stateRoot, closingArgs) {
  clarifiedGoalReferences({ ...record, goalAcceptanceClarifications: [receipt] }, goal, goal.goal.criteria[0]);
  if (!validateAcceptedContent(record.accepted, target).valid) fail('accepted target changed', 'GOAL_ACCEPTANCE_STALE');
  await verifySource(goal.source);
  const closure = await verifyClarificationCustody({ record, goal, stateRoot, adapters, closingArgs });
  const binding = { unit: record.unit, goalId: goal.goal.id, userInputRef: receipt.userInputRef,
    effect: 'unit.goal-acceptance.clarify', argsDigest: receipt.requestDigest, sourceDigest: goal.source.digest,
    definitionDigest: receipt.definitionDigest, basisDigest: receipt.basisDigest, targetDigest: effectArgsDigest(target),
    unitDigest: effectArgsDigest(record), goalDigest: effectArgsDigest(goal), custodyDigest: effectArgsDigest(goalOwner(goal, record.unit) ?? null), ...(closure ? { nativeClosureDigest: effectArgsDigest(closure) } : {}) };
  await verifyApprovalInput(adapters.provider, binding);
  if (typeof adapters.provider?.verifyGoalAcceptanceClarification !== 'function') fail('trusted source clarification verification is required', 'ADAPTER_MISSING');
  const verified = await adapters.provider.verifyGoalAcceptanceClarification({ ...binding, request: structuredClone(receipt.request),
    record: structuredClone(record), goal: structuredClone(goal), target: structuredClone(target) });
  if (verified?.verified !== true || Object.entries(binding).some(([key, value]) => verified[key] !== value))
    fail('original obligations, mapping authority or external requirements are unverified', 'GOAL_ACCEPTANCE_UNPROVEN');
  await verifySource(goal.source);
  await verifyAcceptanceCorrections(record, adapters, target);
  if (effectArgsDigest(await verifyClarificationCustody({ record, goal, stateRoot, adapters, closingArgs })) !== effectArgsDigest(closure))
    fail('native closure evidence changed', 'GOAL_ACCEPTANCE_STALE');
}

export async function verifyGoalAcceptanceClarification({ record, stateRoot, adapters, target, closingArgs }) {
  const receipt = record.goalAcceptanceClarifications?.at(-1);
  if (!receipt) return;
  const goal = await createContinuityStore(stateRoot).read(record.continuity?.goalId);
  if (!goal) fail('original goal is missing');
  await verifyClarification(record, goal, receipt, adapters, target, stateRoot, closingArgs);
}

export async function clarifyGoalAcceptance({ stateRoot, store, unit, request, userInputRef, adapters }) {
  if (!fields(request, ['id', 'expectedRevision', 'expectedGoalRevision', 'unitDigest', 'goalDigest', 'targetDigest', 'mappings', 'provenance', 'reason'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.', '..'].includes(request.id)
    || ![request.expectedRevision, request.expectedGoalRevision].every(value => Number.isSafeInteger(value) && value > 0)
    || ![request.unitDigest, request.goalDigest, request.targetDigest].every(sha)
    || !fields(request.provenance, ['ref', 'digest']) || typeof request.provenance.ref !== 'string' || !request.provenance.ref.trim() || !sha(request.provenance.digest)
    || typeof request.reason !== 'string' || !request.reason.trim() || typeof userInputRef !== 'string' || !userInputRef.trim()) fail('exact current state, source authority and explicit mappings are required');
  if (typeof adapters.git?.inspectUnit !== 'function') fail('live Git inspection is required', 'ADAPTER_MISSING');
  if (!await store.read(unit)) fail('unit not found', 'UNIT_NOT_FOUND');
  const goals = createContinuityStore(stateRoot), requestDigest = effectArgsDigest({ request, userInputRef });
  const duplicate = new Error('clarification already recorded');
  let receipt, lock;
  try {
    await withGoalAcceptanceRecoveryLock({ stateRoot, unit, requestDigest }, async lockMetadata => {
    await createLedgerStore(stateRoot).withLock(unit, async ledger => {
      const rows = await ledger.read();
      await store.update(unit, async record => {
        const previous = record.goalAcceptanceClarifications?.find(item => item.request.id === request.id);
        if (previous) {
          if (previous.requestDigest !== requestDigest) fail('clarification id binds another request', 'GOAL_ACCEPTANCE_CONFLICT');
          receipt = { ...previous, duplicate: true }; throw duplicate;
        }
        if (record.revision !== request.expectedRevision || effectArgsDigest(record) !== request.unitDigest) fail('unit changed', 'GOAL_ACCEPTANCE_STALE');
        if (record.goalAcceptanceClarifications?.length || !record.continuity?.goalId || ['review', 'ops'].includes(record.kind)
          || !(record.state === 'Accepted' || record.state === 'Stopped' && record.stoppedFrom === 'Accepted') || !record.accepted
          || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
          || record.stages?.some(stage => stage.attempts?.some(attempt => !attempt.endedAt))) fail('an accepted, undelivered original change unit is required');
        if (rows.some(row => row.event === 'intent' && !sessionEffectRetired(rows, row)
          && !rows.some(done => done.event === 'result' && done.seq === row.seq && done.key === row.key && !['unknown', 'uncertain'].includes(done.result?.status))))
          fail('unresolved effects require investigation', 'EFFECT_UNCERTAIN');
        lock = await acquireContinuityLock(path.join(path.resolve(stateRoot), 'goals', record.continuity.goalId, '.lock'));
        const goal = await goals.read(record.continuity.goalId);
        if (!goal || goal.revision !== request.expectedGoalRevision || effectArgsDigest(goal) !== request.goalDigest
          || !['active', 'blocked'].includes(goal.goal.status) || goal.goal.remaining[0] !== unit
          || goal.completionReservation || goal.reworkReservation) fail('goal changed or is reserved', 'GOAL_ACCEPTANCE_STALE');
        if (effectArgsDigest(record.request?.overallGoal) !== effectArgsDigest(definition(goal))) fail('unit does not retain the original goal definition');
        assertMappings(request.mappings, goal, record);
        await assertReviewsSettled({ stateRoot, store, goal, unit });
        const target = await adapters.git.inspectUnit({ unit, record });
        if (effectArgsDigest(target) !== request.targetDigest) fail('target changed', 'GOAL_ACCEPTANCE_STALE');
        const review = record.reviewedHead ? { verdict: record.verdict, head: record.reviewedHead, contentFingerprint: record.reviewDecision?.contentFingerprint } : null;
        if (!evaluateAcceptance({ acceptance: productAcceptance(record), evidence: record.evidence ?? [], requiredGates: selectProfile(record.kind).gates,
          head: record.head, contentFingerprint: record.contentFingerprint, currentHead: target.head, currentContentFingerprint: target.contentFingerprint,
          reviewRequired: record.reviewDecision?.required === true || record.policy?.review?.mode === 'required', review, findings: record.findings ?? [], enforceSnapshot: true }).ok)
          fail('original accepted gate and review evidence is unproven', 'GOAL_ACCEPTANCE_UNPROVEN');
        receipt = { request: structuredClone(request), userInputRef, requestDigest, definitionDigest: effectArgsDigest(definition(goal)),
          basisDigest: effectArgsDigest(goalAcceptanceBasis(record)), originalAccepted: structuredClone(record.accepted), custody: structuredClone(goalOwner(goal, unit) ?? null), revision: record.revision + 1, clarifiedAt: adapters.now() };
        await verifyClarification(record, goal, receipt, adapters, target, stateRoot);
        if (effectArgsDigest(await adapters.git.inspectUnit({ unit, record })) !== request.targetDigest) fail('target changed during verification', 'GOAL_ACCEPTANCE_STALE');
        lock.assertHeld();
        return { ...record, goalAcceptanceClarifications: [...(record.goalAcceptanceClarifications ?? []), receipt] };
      }, { lockMetadata });
    }, { lockMetadata });
    });
  } catch (error) { if (error !== duplicate) throw error; } finally { await lock?.close(); }
  return receipt;
}

// The final unit must cover the whole retained goal; earlier units may leave work for successors.
export async function validateInitialGoalAcceptance({ record, acceptance, goal, store }) {
  if (!goal || goal.goal.status !== 'active' || !goal.goal.remaining.includes(record.unit)
    || effectArgsDigest(record.request?.overallGoal) !== effectArgsDigest(definition(goal))) fail('current original goal binding is required');
  await verifySource(goal.source);
  if (new Set(acceptance.map(item => item.id)).size !== acceptance.length) fail('acceptance references must be unique');
  const exact = criterion => acceptance.some(item => active(item) && item.text === criterion);
  const retained = new Set();
  for (const transfer of goal.transfers ?? []) {
    const prior = await store.read(transfer.unit);
    const delivered = prior?.state === 'Delivered' && transfer.deliveredContinuation === true && transfer.unitDigest === effectArgsDigest(prior);
    if (!prior?.accepted || prior.continuity?.goalId !== goal.goal.id || prior.state !== 'Closed' && !delivered || hasInvalidEvidence(prior.evidence ?? [])) continue;
    const coverage = acceptanceCoverage(productAcceptance(prior), prior.evidence ?? []);
    if (!coverage.ok) continue;
    for (const criterion of goal.goal.criteria) {
      const refs = clarifiedGoalReferences(prior, goal, criterion)
        ?? prior.acceptance.filter(item => active(item) && item.text === criterion).map(item => item.id);
      if (refs.length && refs.every(ref => hasGoalReferenceEvidence(prior, ref, goal, coverage))) retained.add(criterion);
    }
  }
  const missing = goal.goal.criteria.filter(criterion => !exact(criterion) && !retained.has(criterion));
  if (goal.goal.remaining.length === 1 ? missing.length : !goal.goal.criteria.some(exact))
    fail('scope acceptance does not bind the original goal criteria; retain exact text before execution', 'GOAL_ACCEPTANCE_MISMATCH');
}
