import { goalOwner } from './continuity-custody.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContinuityStore } from './continuity-store.mjs';
import { decideContinuity } from './continuity-decision.mjs';
import { validateGoalCompletion } from './continuity-completion.mjs';

export async function prepareGoalFinish({stateRoot,store,record,unit,parentRuntime,successor,goalComplete,goalProof}) {
  let continuity;
  if (record.continuityRequired && !record.continuity?.goalId) {
    throw Object.assign(new Error('session finish requires a registered overall goal'), { code: 'CONTINUITY_REQUIRED' });
  }
  if (record.continuity?.goalId) {
    continuity = await createContinuityStore(stateRoot).read(record.continuity.goalId);
    if (!continuity) throw Object.assign(new Error('overall goal is missing'), { code: 'CONTINUITY_REQUIRED' });
    const source = await readFile(continuity.source.path);
    if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== continuity.source.digest)
      throw Object.assign(new Error('overall goal source changed'), { code: 'CONTINUITY_STALE' });
    const custody = goalOwner(continuity, unit);
    if (!custody || !parentRuntime || custody.sessionId !== parentRuntime.sessionId
      || custody.incarnationId !== parentRuntime.incarnationId || custody.cwd !== parentRuntime.cwd)
      throw Object.assign(new Error('managed session ownership is not verified'), { code: 'SESSION_OWNER_MISMATCH' });
    for (const review of (continuity.reviews ?? []).filter(item => item.targetUnit === unit)) {
      const reviewed = await store.read(review.unit);
      if (!reviewed || reviewed.state !== 'Closed' || !reviewed.sessionFinalization?.closeReceipt?.result?.closed)
        throw Object.assign(new Error('independent review session has not returned and closed'), {code:'SESSION_CLOSE_PENDING'});
    }
    const transfer = continuity.transfers?.find(item => item.unit === unit);
    if (transfer) {
      if (!successor?.approved || transfer.successor !== successor.unit || transfer.goalDigest !== record.goalSnapshot?.digest)
        throw Object.assign(new Error('goal transfer differs from the recorded successor'), { code: 'CONTINUITY_STALE' });
    } else if (goalComplete) {
      await validateGoalCompletion({ continuity, unit, proof: goalProof, unitStore: store });
    } else {
      const decision = decideContinuity({ goal: continuity.goal, unit, successor, goalComplete });
      if (decision.kind === 'blocked') throw Object.assign(new Error('overall goal is blocked'), { code: 'GOAL_BLOCKED' });
    }
  }
  return continuity;
}

export async function recordGoalTransfer({stateRoot,continuity,goalSnapshot,unit,successor,started}) {
  if (continuity && goalSnapshot) {
    await createContinuityStore(stateRoot).transaction(continuity.goal.id, current => {
      const previous = current?.transfers?.find(item => item.unit === unit);
      if (previous) {
        if (previous.successor !== successor.unit || previous.goalDigest !== goalSnapshot.digest || previous.effectKey !== started.key
          || previous.sessionId !== started.result.sessionId || previous.incarnationId !== started.result.incarnationId || previous.cwd !== started.result.cwd)
          throw Object.assign(new Error('goal transfer conflicts with recorded effect'), { code: 'CONTINUITY_STALE' });
        return current;
      }
      if (!current || current.revision !== continuity.revision || !current.goal.remaining.includes(unit))
        throw Object.assign(new Error('goal changed while successor was starting'), { code: 'CONTINUITY_STALE' });
      return { ...current, revision: current.revision + 1,
        goal: { ...current.goal, remaining: current.goal.remaining.filter(item => item !== unit) },
        transfers: [...(current.transfers ?? []), { unit, successor: successor.unit, goalDigest: goalSnapshot.digest, effectKey: started.key, sessionId: started.result.sessionId, incarnationId: started.result.incarnationId, cwd: started.result.cwd }] };
    });
  }
}

export async function commitGoalContinuation({continuityStore,unitStore,goalId,unit}) {
  const record = await unitStore.read(unit);
  const intent = record?.goalContinuation;
  if (record?.state !== 'Closed' || intent?.goalId !== goalId || !intent.nextUnit || !intent.owner) {
    throw Object.assign(new Error('closed unit with same-session goal continuation is required'), {code:'CONTINUITY_INVALID'});
  }
  return continuityStore.transaction(goalId, current => {
    const previous = current?.transfers?.find(item => item.unit === unit);
    if (previous?.sameSession === true && previous.successor === intent.nextUnit
      && previous.sessionId === intent.owner.sessionId && previous.incarnationId === intent.owner.incarnationId && previous.cwd === intent.owner.cwd) return current;
    const owner = goalOwner(current, unit);
    if (!current || current.revision !== intent.revision || current.goal.status !== 'active'
      || current.goal.remaining[0] !== unit || current.goal.remaining[1] !== intent.nextUnit || previous
      || owner?.sessionId !== intent.owner.sessionId || owner?.incarnationId !== intent.owner.incarnationId || owner?.cwd !== intent.owner.cwd) {
      throw Object.assign(new Error('goal continuation or session owner changed'), {code:'CONTINUITY_STALE'});
    }
    const identity = {sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd:owner.cwd,
      ...(owner.ownership === 'existing' ? {ownership:'existing',owner:owner.owner} : {})};
    return {...current,revision:current.revision+1,goal:{...current.goal,remaining:current.goal.remaining.slice(1)},
      ...(owner.ownership === 'existing'
        ? {adoptions:[...(current.adoptions ?? []),{unit:intent.nextUnit,inheritedFrom:unit,goalRevision:current.revision+1,...identity}]}
        : {bootstraps:[...(current.bootstraps ?? []),{unit:intent.nextUnit,attempt:1,...identity}]}),
      transfers:[...(current.transfers ?? []),{unit,successor:intent.nextUnit,sameSession:true,...identity}]};
  });
}
