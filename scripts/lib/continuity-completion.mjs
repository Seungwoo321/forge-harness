import { clarifiedGoalReferences, hasGoalReferenceEvidence } from './goal-acceptance-binding.mjs';
import { acceptanceCoverage, hasInvalidEvidence } from './evidence.mjs';
import { productAcceptance } from './acceptance-correction.mjs';
import { effectArgsDigest } from './approvals.mjs';

const invalid = message => Object.assign(new Error(message), { code: 'GOAL_INCOMPLETE' });
const stableFinalization = plan => {
  const {deliveryReceipt, ownerRetained, closeReceipt, ...stable} = plan ?? {};
  return plan ? stable : null;
};

export async function validateGoalCompletion({ continuity, unit, proof, unitStore, requireClosed = false }) {
  if (continuity?.goal?.status !== 'active' || continuity.goal.remaining.length !== 1 || continuity.goal.remaining[0] !== unit)
    throw invalid('other goal work remains or the goal is not active');
  if (!Array.isArray(proof) || proof.length !== continuity.goal.criteria.length) throw invalid('each goal criterion needs accepted evidence');
  const goalUnits = new Set([unit, ...(continuity.transfers ?? []).map(item => item.unit)]);
  const seen = new Set();
  for (const item of proof) {
    if (!item || !continuity.goal.criteria.includes(item.criterion) || seen.has(item.criterion) || !goalUnits.has(item.unit)) throw invalid('goal criterion evidence does not match the goal');
    seen.add(item.criterion);
    const record = await unitStore.read(item.unit);
    const retainedDelivery = item.unit !== unit && record?.state === 'Delivered' && (continuity.transfers ?? []).some(transfer =>
      transfer.unit === item.unit && transfer.deliveredContinuation === true && transfer.unitDigest === effectArgsDigest(record));
    if (!record || record.continuity?.goalId !== continuity.goal.id || !record.accepted
      || (item.unit === unit && !requireClosed ? !['Accepted', 'Delivering', 'Delivered'].includes(record.state) : record.state !== 'Closed' && !retainedDelivery)) throw invalid('goal evidence must come from an accepted goal unit');
    const coverage = acceptanceCoverage(productAcceptance(record), record.evidence ?? []);
    const mapped = clarifiedGoalReferences(record, continuity, item.criterion);
    const refs = mapped ?? [item.acceptance];
    if (mapped && (Object.hasOwn(item, 'acceptance') || effectArgsDigest(item.acceptances) !== effectArgsDigest(mapped))
      || !mapped && Object.hasOwn(item, 'acceptances')) throw invalid('goal proof differs from its explicit mapping');
    if (record.acceptance?.some(entry => entry.status === 'deferred') || hasInvalidEvidence(record.evidence ?? []) || !coverage.ok)
      throw invalid('goal acceptance evidence is missing');
    for (const ref of refs) {
      const criterion = record.acceptance?.find(entry => entry.id === ref);
      // A clarification changes only the explicit relation, never product or external evidence requirements.
      if (!criterion || !mapped && criterion.text !== item.criterion
        || !hasGoalReferenceEvidence(record, ref, continuity, coverage)) throw invalid('goal acceptance evidence is missing');
    }
  }
  return true;
}

export async function commitGoalCompletion({ continuityStore, unitStore, goalId, unit }) {
  const current = await continuityStore.read(goalId);
  if (current?.goal.status === 'complete' && current.completion?.unit === unit) return current;
  const record = await unitStore.read(unit);
  const completion = record?.goalCompletion;
  const reservation = current?.completionReservation;
  if (!completion || completion.goalId !== goalId || (reservation ? reservation.unit !== unit || reservation.completionDigest !== effectArgsDigest(completion) : completion.revision !== current?.revision)) throw invalid('matching goal completion intent is missing');
  await validateGoalCompletion({ continuity:current, unit, proof:completion.proof, unitStore, requireClosed:true });
  return continuityStore.transaction(goalId, goal => {
    if (!goal || goal.revision !== current.revision || goal.goal.status !== 'active') throw invalid('goal changed during completion');
    const {completionReservation, ...rest} = goal;
    return {...rest, revision:goal.revision+1, goal:{...goal.goal,status:'complete',remaining:[]}, completion:{unit,proof:completion.proof}};
  }, reservation ? {completionReservation:effectArgsDigest(reservation)} : {});
}

// Do not let a stale finalizer submit another result after goal work or rework changed.
export async function fenceGoalDelivery({continuityStore,unitStore,unit,plan,action}) {
  let result;
  await unitStore.withLock(unit,async record=>{
    if (effectArgsDigest(stableFinalization(record.sessionFinalization))!==effectArgsDigest(stableFinalization(plan)))
      throw invalid('finalization changed before result delivery');
    if (record.kind==='review' || record.state==='Stopped') {result=await action();return;}
    const goalId=record.continuity?.goalId;
    if (!goalId) {result=await action();return;}
    const current=await continuityStore.read(goalId), reservation=current?.completionReservation;
    await continuityStore.transaction(goalId,async goal=>{
      if (!goal || goal.revision!==current?.revision) throw invalid('goal changed before result delivery');
      const completion=record.goalCompletion;
      if (reservation) {
        if (reservation.unit!==unit || reservation.completionDigest!==effectArgsDigest(completion ?? null)
          || reservation.planDigest!==effectArgsDigest(stableFinalization(plan) ?? {})) throw invalid('completion reservation differs');
        result=await action({completedOnly:true});return goal;
      }
      if (goal.goal.status==='complete') {
        if (record.state!=='Closed' || goal.completion?.unit!==unit) throw invalid('goal completion belongs to another unit');
        result=await action({completedOnly:true});return goal;
      }
      if (goal.goal.status!=='active' || completion && completion.revision!==goal.revision)
        throw invalid('goal changed before result delivery');
      result=await action();return goal;
    },reservation ? {completionReservation:effectArgsDigest(reservation)} : {});
  });
  return result;
}

// Serialize the irreversible owner close with goal amendments and unit rework.
export async function fenceGoalClose({ continuityStore, unitStore, unit, plan, completion, action }) {
  let result;
  await unitStore.withLock(unit, async record => {
    if (effectArgsDigest(stableFinalization(record.sessionFinalization)) !== effectArgsDigest(stableFinalization(plan))
      || effectArgsDigest(record.goalCompletion ?? null) !== effectArgsDigest(completion))
      throw invalid('finalization changed before session close');
    if (!completion) { result = await action(); return; }
    const prior={accepted:record.accepted,deliveryResult:record.deliveryResult,deliveryPlan:record.deliveryPlan,
      sessionFinalization:stableFinalization(record.sessionFinalization),goalCompletion:record.goalCompletion,evidence:record.evidence,
      reviewDecision:record.reviewDecision,reviewedHead:record.reviewedHead,verdict:record.verdict,result:record.result,resultRef:record.resultRef,next:record.next};
    const reservation = {unit, goalRevision:completion.revision, completionDigest:effectArgsDigest(completion), planDigest:effectArgsDigest(stableFinalization(plan) ?? {}), acceptedDigest:effectArgsDigest(record.accepted), accepted:structuredClone(record.accepted), prior};
    const token = effectArgsDigest(reservation);
    await continuityStore.transaction(completion.goalId, async continuity => {
      if (record.state==='Closed' && continuity?.goal.status==='complete' && continuity.completion?.unit===unit
        && effectArgsDigest(continuity.completion.proof)===effectArgsDigest(completion.proof)) {
        result=await action({completedOnly:true});
        return continuity;
      }
      if (continuity?.completionReservation) {
        if (effectArgsDigest(continuity.completionReservation) !== token) throw invalid('different finalization reserved this goal');
        return continuity;
      }
      if (continuity?.revision !== completion.revision) throw invalid('goal changed before session close');
      await validateGoalCompletion({continuity,unit,proof:completion.proof,unitStore});
      return {...continuity,revision:continuity.revision+1,completionReservation:reservation};
    }, {completionReservation:token});
    if (result===undefined) result = await action();
  });
  return result;
}
