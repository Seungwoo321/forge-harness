import { acceptanceCoverage, hasInvalidEvidence } from './evidence.mjs';
import { currentCorrections, correctionSource, productAcceptance } from './acceptance-correction.mjs';
import { effectArgsDigest } from './approvals.mjs';

const invalid = message => Object.assign(new Error(message), { code: 'GOAL_INCOMPLETE' });

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
    if (!record || record.continuity?.goalId !== continuity.goal.id || !record.accepted
      || (item.unit === unit && !requireClosed ? !['Accepted', 'Delivering', 'Delivered'].includes(record.state) : record.state !== 'Closed')) throw invalid('goal evidence must come from an accepted goal unit');
    const coverage = acceptanceCoverage(productAcceptance(record), record.evidence ?? []);
    const correction = currentCorrections(record).find(receipt => receipt.request.acceptanceRef === item.acceptance);
    const criterion = record.acceptance?.find(entry => entry.id === item.acceptance);
    const corrected = correction && criterion && effectArgsDigest(correctionSource(record)) === correction.request.sourceDigest
      && effectArgsDigest(criterion) === correction.request.criterionDigest
      && effectArgsDigest({ request: correction.request, userInputRef: correction.userInputRef }) === correction.requestDigest;
    // Preflight maps retained obligations; only the guarded terminal paths can produce Closed goal evidence.
    if (record.acceptance?.some(entry => entry.status === 'deferred') || hasInvalidEvidence(record.evidence ?? [])
      || !record.acceptance?.some(entry => entry.id === item.acceptance && entry.text === item.criterion && !['deferred','dropped'].includes(entry.status))
      || !coverage.ok || !coverage.covered.includes(item.acceptance) && !corrected) throw invalid('goal acceptance evidence is missing');
  }
  return true;
}

export async function commitGoalCompletion({ continuityStore, unitStore, goalId, unit }) {
  const current = await continuityStore.read(goalId);
  if (current?.goal.status === 'complete' && current.completion?.unit === unit) return current;
  const record = await unitStore.read(unit);
  const completion = record?.goalCompletion;
  if (!completion || completion.goalId !== goalId || completion.revision !== current?.revision) throw invalid('matching goal completion intent is missing');
  await validateGoalCompletion({ continuity:current, unit, proof:completion.proof, unitStore, requireClosed:true });
  return continuityStore.transaction(goalId, goal => {
    if (!goal || goal.revision !== completion.revision || goal.goal.status !== 'active') throw invalid('goal changed during completion');
    return {...goal, revision:goal.revision+1, goal:{...goal.goal,status:'complete',remaining:[]}, completion:{unit,proof:completion.proof}};
  });
}
