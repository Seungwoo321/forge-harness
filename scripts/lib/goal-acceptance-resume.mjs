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

const fail = (message, code = 'GOAL_ACCEPTANCE_RESUME_INVALID') => { throw Object.assign(new Error(message), { code }); };
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const text = value => typeof value === 'string' && value.trim().length > 0;
const fields = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const retainedClarificationResume = (goal, unit) => goal?.retainedClarificationResumptions?.findLast(item => item.unit === unit);

function assertRequest(request, userInputRef) {
  if (!fields(request, ['id', 'expectedRevision', 'unit', 'unitDigest', 'goalDigest', 'ledgerDigest', 'targetDigest', 'custodyDigest', 'clarification', 'resolutionEvidence', 'reason'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.', '..'].includes(request.id)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || !text(request.unit)
    || !['unitDigest', 'goalDigest', 'ledgerDigest', 'targetDigest', 'custodyDigest'].every(key => sha(request[key]))
    || !fields(request.clarification, ['id', 'digest']) || !text(request.clarification.id) || !sha(request.clarification.digest)
    || !fields(request.resolutionEvidence, ['ref', 'digest']) || !text(request.resolutionEvidence.ref) || !sha(request.resolutionEvidence.digest)
    || !text(request.reason) || !text(userInputRef)) fail('exact retained clarification, current state and original human authority are required');
}

function originalGoal(goal, receipt) {
  if (goal.revision !== receipt.goalRevision || goal.goal.status !== 'active'
    || effectArgsDigest(goal.blockerHistory?.at(-1)) !== effectArgsDigest({ ...receipt.blocker, resolutionEvidence: receipt.request.resolutionEvidence.ref }))
    fail('goal changed after retained continuation was authorized', 'GOAL_ACCEPTANCE_RESUME_STALE');
  const before = { ...goal, revision: receipt.request.expectedRevision, goal: { ...goal.goal, status: 'blocked', blocker: receipt.blocker } };
  if (receipt.hadHistory) before.retainedClarificationResumptions = goal.retainedClarificationResumptions.slice(0, -1);
  else delete before.retainedClarificationResumptions;
  if (receipt.hadBlockerHistory) before.blockerHistory = goal.blockerHistory.slice(0, -1);
  else delete before.blockerHistory;
  return before;
}

async function verifyLiveResume({ stateRoot, store, record, goal, rows, request, userInputRef, adapters }) {
  assertRequest(request, userInputRef);
  const unit = record.unit, receipt = record.goalAcceptanceClarifications?.at(-1), custody = goalOwner(goal, unit), report = record.stopReport;
  if (request.unit !== unit || record.state !== 'Stopped' || record.stoppedFrom !== 'Accepted' || !record.accepted
    || record.sessionFinalization || record.deliveryPlan || record.deliveryResult || !report || !receipt
    || goal.goal.status !== 'blocked' || goal.goal.remaining[0] !== unit || goal.goal.blocker?.unit !== unit
    || record.continuity?.goalId !== goal.goal.id || report.goalRevision !== goal.revision
    || record.stages?.some(stage => stage.attempts?.some(attempt => !attempt.endedAt))) fail('only the original retained Accepted stop can continue');
  if (goal.revision !== request.expectedRevision || effectArgsDigest(goal) !== request.goalDigest || effectArgsDigest(record) !== request.unitDigest
    || effectArgsDigest(rows) !== request.ledgerDigest || effectArgsDigest(custody ?? null) !== request.custodyDigest
    || effectArgsDigest(custody) !== effectArgsDigest(receipt.custody)
    || receipt.request.id !== request.clarification.id || effectArgsDigest(receipt) !== request.clarification.digest)
    fail('original stopped state, clarification or custody changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
  if (goal.completionReservation || goal.reworkReservation || rows.some(row => row.event === 'intent' && !sessionEffectRetired(rows, row)
    && !rows.some(done => done.event === 'result' && done.seq === row.seq && done.key === row.key && !['unknown', 'uncertain'].includes(done.result?.status))))
    fail('unresolved operations prevent live continuation', 'EFFECT_UNCERTAIN');
  if (!custody || ['sessionId', 'incarnationId', 'cwd'].some(key => report.owner?.[key] !== custody[key])) fail('retained stop owner changed');
  const failure = record.failures?.find(item => item.path === goal.goal.blocker.evidence);
  if (!failure?.path?.startsWith(`units/${unit}/failures/`)) fail('original blocker failure is required');
  const verifyFiles = async () => {
    for (const [file, digest] of [[path.resolve(stateRoot, failure.path), failure.digest],
      ...['result', 'handoff', 'goal'].map(name => [report[`${name}Path`], report[`${name}Digest`]])]) {
      if (!path.isAbsolute(file ?? '') || !sha(digest) || `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}` !== digest)
        fail('original stop or failure evidence changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
    }
  };
  await verifyFiles();
  const originalFailure = JSON.parse(await readFile(path.resolve(stateRoot, failure.path), 'utf8'));
  if (originalFailure.class !== 'user-domain' || originalFailure.action !== 'defer') fail('product retries or other failure classes require their ordinary recovery');
  if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.provider?.verifyGoalAcceptanceResume !== 'function')
    fail('trusted live continuation and target verification are required', 'ADAPTER_MISSING');
  const target = await adapters.git.inspectUnit({ unit, record });
  if (effectArgsDigest(target) !== request.targetDigest) fail('accepted target changed', 'GOAL_ACCEPTANCE_RESUME_STALE');
  await assertReviewsSettled({ stateRoot, store, goal, unit });
  await verifyGoalAcceptanceClarification({ record, stateRoot, adapters, target });
  const binding = { unit, goalId: goal.goal.id, userInputRef, effect: 'goal.resume.retained-clarification', argsDigest: effectArgsDigest({ request, userInputRef }),
    unitDigest: request.unitDigest, goalDigest: request.goalDigest, ledgerDigest: request.ledgerDigest, targetDigest: request.targetDigest,
    custodyDigest: request.custodyDigest, clarificationDigest: request.clarification.digest, stopReportDigest: effectArgsDigest(report), failureDigest: failure.digest,
    policyDigest: effectArgsDigest(goal.policy) };
  await verifyApprovalInput(adapters.provider, binding);
  const proof = await adapters.provider.verifyGoalAcceptanceResume({ ...binding, request: structuredClone(request), record: structuredClone(record),
    goal: structuredClone(goal), target: structuredClone(target), failure: structuredClone(originalFailure) });
  if (proof?.verified !== true || proof.bindingOnly !== true || Object.entries(binding).some(([key, value]) => proof[key] !== value))
    fail('the binding-only blocker and same-owner continuation authority are unproven', 'GOAL_ACCEPTANCE_RESUME_UNPROVEN');
  await verifyFiles(); await verifyNativeCustody(record, goal, adapters);
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
        const previous = goal.retainedClarificationResumptions?.find(item => item.request.id === request.id);
        if (previous && (previous.requestDigest !== requestDigest || retainedClarificationResume(goal, record.unit) !== previous)) fail('continuation id conflicts', 'GOAL_ACCEPTANCE_RESUME_CONFLICT');
        const before = previous ? originalGoal(goal, previous) : goal;
        const binding = await verifyLiveResume({ stateRoot, store, record, goal: before, rows, request, userInputRef, adapters });
        if (previous) return goal;
        const resumed = resumeGoal(goal, { ...request, resolutionEvidence: request.resolutionEvidence.ref });
        const receipt = { unit: record.unit, request: structuredClone(request), userInputRef, requestDigest, binding, blocker: goal.goal.blocker,
          goalRevision: resumed.revision, hadHistory: Object.hasOwn(goal, 'retainedClarificationResumptions'), hadBlockerHistory: Object.hasOwn(goal, 'blockerHistory') };
        return { ...resumed, retainedClarificationResumptions: [...(goal.retainedClarificationResumptions ?? []), receipt] };
      });
    }, { lockMetadata }), { lockMetadata }));
}

export async function verifyRetainedClarificationStop({ stateRoot, store, record, goal, rows, adapters, recovery }) {
  const receipt = retainedClarificationResume(goal, record.unit);
  if (!receipt || recovery?.action !== 'resume') fail('retained continuation requires unchanged accepted content and passing fingerprints', 'GOAL_ACCEPTANCE_RESUME_STALE');
  const before = originalGoal(goal, receipt);
  await verifyLiveResume({ stateRoot, store, record, goal: before, rows, request: receipt.request, userInputRef: receipt.userInputRef, adapters });
  return { mode: 'retained-clarification', requestDigest: receipt.requestDigest, stopReport: structuredClone(record.stopReport), custodyDigest: receipt.request.custodyDigest };
}
