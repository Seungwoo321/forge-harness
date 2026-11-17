import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { goalOwner, assertReviewsSettled } from './continuity-custody.mjs';
import { resumeGoal } from './continuity-transitions.mjs';
import { verifyGoalAcceptanceClarification, verifyNativeCustody } from './goal-acceptance-binding.mjs';
import { withGoalAcceptanceRecoveryLock } from './goal-acceptance-lock.mjs';
import { validateAcceptedContent } from './delivery.mjs';

const fail = (message, code = 'GOAL_ACCEPTANCE_RESUME_INVALID') => { throw Object.assign(new Error(message), { code }); };
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const text = value => typeof value === 'string' && value.trim().length > 0;
const fields = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const retainedClarificationResume = (goal, unit) => goal?.retainedClarificationResumptions?.findLast(item => item.unit === unit);
const historyField = request => request.externalResolution ? 'retainedExternalResumptions' : 'retainedClarificationResumptions';
export function retainedOwnerResume(goal, unit) {
  const receipts = [retainedClarificationResume(goal, unit), goal?.retainedExternalResumptions?.findLast(item => item.unit === unit)].filter(Boolean);
  if (receipts.length > 1) fail('conflicting retained continuation histories', 'GOAL_ACCEPTANCE_RESUME_CONFLICT');
  return receipts[0];
}

function assertRequest(request, userInputRef) {
  const external = Boolean(request?.externalResolution);
  if (!fields(request, ['id', 'expectedRevision', 'unit', 'unitDigest', 'goalDigest', 'ledgerDigest', 'targetDigest', 'custodyDigest', external ? 'externalResolution' : 'clarification', 'resolutionEvidence', 'reason'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.', '..'].includes(request.id)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || !text(request.unit)
    || !['unitDigest', 'goalDigest', 'ledgerDigest', 'targetDigest', 'custodyDigest'].every(key => sha(request[key]))
    || (external ? !fields(request.externalResolution, ['ref', 'digest']) || !text(request.externalResolution.ref) || !sha(request.externalResolution.digest)
      : !fields(request.clarification, ['id', 'digest']) || !text(request.clarification.id) || !sha(request.clarification.digest))
    || !fields(request.resolutionEvidence, ['ref', 'digest']) || !text(request.resolutionEvidence.ref) || !sha(request.resolutionEvidence.digest)
    || !text(request.reason) || !text(userInputRef)) fail('exact retained continuation, current state and original human authority are required');
}

function originalGoal(goal, receipt) {
  if (goal.revision !== receipt.goalRevision || goal.goal.status !== 'active'
    || effectArgsDigest(goal.blockerHistory?.at(-1)) !== effectArgsDigest({ ...receipt.blocker, resolutionEvidence: receipt.request.resolutionEvidence.ref }))
    fail('goal changed after retained continuation was authorized', 'GOAL_ACCEPTANCE_RESUME_STALE');
  const before = { ...goal, revision: receipt.request.expectedRevision, goal: { ...goal.goal, status: 'blocked', blocker: receipt.blocker } };
  const field = historyField(receipt.request);
  if (receipt.hadHistory) before[field] = goal[field].slice(0, -1);
  else delete before[field];
  if (receipt.hadBlockerHistory) before.blockerHistory = goal.blockerHistory.slice(0, -1);
  else delete before.blockerHistory;
  return before;
}

async function verifyLiveResume({ stateRoot, store, record, goal, rows, request, userInputRef, adapters }) {
  assertRequest(request, userInputRef);
  const external = Boolean(request.externalResolution);
  const unit = record.unit, receipt = record.goalAcceptanceClarifications?.at(-1), custody = goalOwner(goal, unit), report = record.stopReport;
  if (request.unit !== unit || record.state !== 'Stopped' || record.stoppedFrom !== 'Accepted' || !record.accepted
    || ['review', 'ops'].includes(record.kind) || record.sessionFinalization || record.deliveryPlan || record.deliveryResult || !report || (!external && !receipt)
    || goal.goal.status !== 'blocked' || goal.goal.remaining[0] !== unit || goal.goal.blocker?.unit !== unit
    || record.continuity?.goalId !== goal.goal.id || report.goalRevision !== goal.revision
    || record.stages?.some(stage => stage.attempts?.some(attempt => !attempt.endedAt))) fail('only the original retained Accepted stop can continue');
  if (goal.revision !== request.expectedRevision || effectArgsDigest(goal) !== request.goalDigest || effectArgsDigest(record) !== request.unitDigest
    || effectArgsDigest(rows) !== request.ledgerDigest || effectArgsDigest(custody ?? null) !== request.custodyDigest
    || !external && (effectArgsDigest(custody) !== effectArgsDigest(receipt.custody)
      || receipt.request.id !== request.clarification.id || effectArgsDigest(receipt) !== request.clarification.digest))
    fail('original stopped state, clarification or custody changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
  if (goal.completionReservation || goal.reworkReservation || rows.some(row => {
    if (row.event !== 'intent' || sessionEffectRetired(rows, row)) return false;
    const result = rows.findLast(done => done.event === 'result' && done.seq === row.seq && done.key === row.key);
    return !result || ['unknown', 'uncertain'].includes(result.result?.status);
  }))
    fail('unresolved operations prevent live continuation', 'EFFECT_UNCERTAIN');
  if (!custody || ['sessionId', 'incarnationId', 'cwd'].some(key => report.owner?.[key] !== custody[key])) fail('retained stop owner changed');
  const failure = record.failures?.find(item => item.path === goal.goal.blocker.evidence);
  if (!failure?.path?.startsWith(`units/${unit}/failures/`)) fail('original blocker failure is required');
  const verifyFiles = async () => {
    for (const [file, digest] of [[path.resolve(stateRoot, failure.path), failure.digest],
      ...(external ? [[goal.source.path, goal.source.digest], [request.externalResolution.ref, request.externalResolution.digest],
        [request.resolutionEvidence.ref, request.resolutionEvidence.digest],
        ...(record.canon ?? []).map(source => [path.resolve(custody.cwd, source.path), source.digest])] : []),
      ...['result', 'handoff', 'goal'].map(name => [report[`${name}Path`], report[`${name}Digest`]])]) {
      if (!path.isAbsolute(file ?? '') || !sha(digest) || `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}` !== digest)
        fail('original stop or failure evidence changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
    }
  };
  await verifyFiles();
  const failureBytes = await readFile(path.resolve(stateRoot, failure.path));
  if (`sha256:${createHash('sha256').update(failureBytes).digest('hex')}` !== failure.digest)
    fail('original failure changed before classification', 'GOAL_ACCEPTANCE_RESUME_STALE');
  const originalFailure = JSON.parse(failureBytes);
  if (originalFailure.class !== 'user-domain' || originalFailure.action !== 'defer') fail('product retries or other failure classes require their ordinary recovery');
  const verifier = external ? 'verifyRetainedExternalResume' : 'verifyGoalAcceptanceResume';
  if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.provider?.[verifier] !== 'function')
    fail('trusted live continuation and target verification are required', 'ADAPTER_MISSING');
  const target = await adapters.git.inspectUnit({ unit, record });
  if (effectArgsDigest(target) !== request.targetDigest) fail('accepted target changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
  if (external && (request.externalResolution.ref !== goal.source.path || request.externalResolution.digest !== goal.source.digest
    || !validateAcceptedContent(record.accepted, target).valid)) fail('original source or accepted content changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
  await assertReviewsSettled({ stateRoot, store, goal, unit });
  await verifyGoalAcceptanceClarification({ record, stateRoot, adapters, target });
  const binding = { unit, goalId: goal.goal.id, userInputRef, effect: external ? 'goal.resume.retained-external' : 'goal.resume.retained-clarification', argsDigest: effectArgsDigest({ request, userInputRef }),
    unitDigest: request.unitDigest, goalDigest: request.goalDigest, ledgerDigest: request.ledgerDigest, targetDigest: request.targetDigest,
    custodyDigest: request.custodyDigest, ...(external ? { sourceDigest: goal.source.digest, resolutionDigest: request.resolutionEvidence.digest,
      acceptedDigest: effectArgsDigest(record.accepted) } : { clarificationDigest: request.clarification.digest }), stopReportDigest: effectArgsDigest(report), failureDigest: failure.digest,
    policyDigest: effectArgsDigest(goal.policy) };
  await verifyApprovalInput(adapters.provider, binding);
  const proof = await adapters.provider[verifier]({ ...binding, request: structuredClone(request), record: structuredClone(record),
    goal: structuredClone(goal), target: structuredClone(target), failure: structuredClone(originalFailure) });
  if (proof?.verified !== true || (external ? proof.externalResolved !== true : proof.bindingOnly !== true) || Object.entries(binding).some(([key, value]) => proof[key] !== value))
    fail(external ? 'actual external resolution and same-owner continuation authority are unproven'
      : 'the binding-only blocker and same-owner continuation authority are unproven', 'GOAL_ACCEPTANCE_RESUME_UNPROVEN');
  await verifyFiles();
  if (external) await assertReviewsSettled({ stateRoot, store, goal, unit });
  await verifyNativeCustody(record, goal, adapters);
  if (effectArgsDigest(await adapters.git.inspectUnit({ unit, record })) !== request.targetDigest) fail('target changed during continuation verification', 'GOAL_ACCEPTANCE_RESUME_STALE');
  return binding;
}

// The goal commits first; a crash leaves the unit Stopped. The same audited request then resumes it, never a new owner.
export async function resumeRetainedClarificationGoal({ stateRoot, store, id, request, userInputRef, adapters }) {
  assertRequest(request, userInputRef);
  const requestDigest = effectArgsDigest({ request, userInputRef });
  return withGoalAcceptanceRecoveryLock({ stateRoot, unit: request.unit, requestDigest }, lockMetadata =>
    createLedgerStore(stateRoot).withLock(request.unit, ledger => store.withLock(request.unit, async record => {
      const rows = await ledger.read();
      return createContinuityStore(stateRoot).transaction(id, async goal => {
        const field = historyField(request), previous = goal[field]?.find(item => item.request.id === request.id);
        const latest = retainedOwnerResume(goal, record.unit);
        if (latest && (!previous || previous.requestDigest !== requestDigest || latest !== previous)) fail('continuation id conflicts', 'GOAL_ACCEPTANCE_RESUME_CONFLICT');
        const before = previous ? originalGoal(goal, previous) : goal;
        const binding = await verifyLiveResume({ stateRoot, store, record, goal: before, rows, request, userInputRef, adapters });
        if (previous) return goal;
        const resumed = resumeGoal(goal, { ...request, resolutionEvidence: request.resolutionEvidence.ref });
        const receipt = { unit: record.unit, request: structuredClone(request), userInputRef, requestDigest, binding, blocker: goal.goal.blocker,
          goalRevision: resumed.revision, hadHistory: Object.hasOwn(goal, field), hadBlockerHistory: Object.hasOwn(goal, 'blockerHistory') };
        return { ...resumed, [field]: [...(goal[field] ?? []), receipt] };
      });
    }, { lockMetadata }), { lockMetadata }));
}

export async function verifyRetainedClarificationStop({ stateRoot, store, record, goal, rows, adapters, recovery }) {
  const receipt = retainedOwnerResume(goal, record.unit), external = Boolean(receipt?.request.externalResolution);
  if (!receipt || !(external ? ['revalidate', 'rerun-gate'] : ['resume']).includes(recovery?.action)) fail('retained continuation requires its verified target and recovery mode', 'GOAL_ACCEPTANCE_RESUME_STALE');
  const before = originalGoal(goal, receipt);
  await verifyLiveResume({ stateRoot, store, record, goal: before, rows, request: receipt.request, userInputRef: receipt.userInputRef, adapters });
  return { mode: external ? 'retained-external' : 'retained-clarification', requestDigest: receipt.requestDigest, stopReport: structuredClone(record.stopReport), custodyDigest: receipt.request.custodyDigest };
}
