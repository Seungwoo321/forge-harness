import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectArgsDigest, verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createLedgerStore, sessionEffectRetired} from './ledger.mjs';
import {goalOwner, nativeOwner, assertReviewsSettled} from './continuity-custody.mjs';
import {resumeGoal} from './continuity-transitions.mjs';
import {selectExecutionPolicy} from './continuity-decision.mjs';

const fail = (message, code = 'STOPPED_OWNER_INVALID') => { throw Object.assign(new Error(message), {code}); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
export const stoppedOwnerRecovery = (goal, unit) => goal?.stoppedOwnerRecoveries?.findLast(item => item.unit === unit);

async function verifyFile(file, digest) {
  if (!path.isAbsolute(file ?? '') || !sha(digest)
    || `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}` !== digest)
    fail('immutable recovery source or stop packet changed', 'STOPPED_OWNER_STALE');
}
function originalGoal(goal, receipt, resumed) {
  const before = {...goal, revision:receipt.request.expectedGoalRevision};
  if (receipt.hadRecoveries) before.stoppedOwnerRecoveries = goal.stoppedOwnerRecoveries.slice(0,-1);
  else delete before.stoppedOwnerRecoveries;
  if (resumed) {
    const resolution = goal.blockerHistory?.at(-1);
    const {resolutionEvidence, ...blocker} = resolution ?? {};
    before.goal = {...goal.goal,status:'blocked',blocker:receipt.blocker};
    if (receipt.hadBlockerHistory) before.blockerHistory = goal.blockerHistory.slice(0,-1);
    else delete before.blockerHistory;
    if (!text(resolutionEvidence) || effectArgsDigest(blocker) !== effectArgsDigest(receipt.blocker))
      fail('goal blocker history changed','STOPPED_OWNER_STALE');
  }
  if (goal.revision !== receipt.goalRevision + (resumed ? 1 : 0)) fail('goal changed after closure recovery','STOPPED_OWNER_STALE');
  return before;
}

// Called only with ledger -> unit -> goal locks held. No external effects occur here.
export async function verifyStoppedOwner({stateRoot,store,record,goal,rows,request,userInputRef,adapters}) {
  const unit = record.unit;
  if (record.state !== 'Stopped' || !['Scoped','Implementing','SelfGated','InReview','Accepted'].includes(record.stoppedFrom)
    || ['review','ops'].includes(record.kind) || record.sessionFinalization
    || record.deliveryPlan || record.deliveryResult || !record.stopReport || record.continuity?.goalId !== goal?.goal.id
    || goal.goal.status !== 'blocked' || goal.goal.remaining[0] !== unit || goal.goal.blocker?.unit !== unit)
    fail('exact retained stopped unit and blocked goal required');
  if (record.revision !== request.expectedRevision || effectArgsDigest(record) !== request.unitDigest
    || goal.revision !== request.expectedGoalRevision || effectArgsDigest(goal) !== request.goalDigest
    || effectArgsDigest(rows) !== request.ledgerDigest) fail('unit, goal or ledger changed','STOPPED_OWNER_STALE');
  if (rows.some(row => row.event === 'intent' && !sessionEffectRetired(rows,row) && !rows.some(result => result.event === 'result'
    && result.seq === row.seq && result.key === row.key && !['unknown','uncertain'].includes(result.result?.status))))
    fail('unresolved effects must be reconciled','EFFECT_UNCERTAIN');
  const custody = goalOwner(goal,unit), owner = nativeOwner(request.owner), report = record.stopReport;
  const execution = selectExecutionPolicy(goal.policy,'implementation');
  if (owner.runtime !== execution.runtime || path.basename(owner.worker.executable) !== execution.provider)
    fail('closed owner differs from the current execution policy','STOPPED_OWNER_STALE');
  if (!custody || effectArgsDigest(custody) !== request.custodyDigest
    || ['sessionId','incarnationId','cwd'].some(key => custody[key] !== owner[key] || report.owner?.[key] !== owner[key])
    || custody.owner && effectArgsDigest(nativeOwner(custody.owner)) !== effectArgsDigest(owner)
    || effectArgsDigest(owner) !== effectArgsDigest(request.owner) || report.goalRevision !== goal.revision)
    fail('retained owner custody or stop report changed','STOPPED_OWNER_STALE');
  if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.session?.observe !== 'function'
    || typeof adapters.provider?.verifyStoppedOwnerRecovery !== 'function') fail('trusted target, native and source verifiers are required','ADAPTER_MISSING');
  const files = async () => {
    await verifyFile(goal.source.path,goal.source.digest);
    for (const source of record.canon ?? []) await verifyFile(path.resolve(owner.cwd,source.path),source.digest);
    for (const name of ['result','handoff','goal']) await verifyFile(report[`${name}Path`],report[`${name}Digest`]);
    const failure = record.failures?.find(item => item.path === goal.goal.blocker.evidence);
    if (!failure || !failure.path.startsWith(`units/${unit}/failures/`)) fail('recorded blocker failure is required');
    await verifyFile(path.resolve(stateRoot,failure.path),failure.digest);
  };
  const observe = async () => {
    const observed = await adapters.session.observe({closedOwner:structuredClone(owner),cwd:owner.cwd});
    if (observed?.closed !== true || effectArgsDigest(observed.owner) !== effectArgsDigest(owner))
      fail('exact native owner closure is unproven','STOPPED_OWNER_UNPROVEN');
    return observed;
  };
  const target = await adapters.git.inspectUnit({unit,record});
  if (effectArgsDigest(target ?? null) !== request.targetDigest) fail('recovery target changed','STOPPED_OWNER_STALE');
  await files();
  await assertReviewsSettled({stateRoot,store,goal,unit});
  await observe();
  const binding = {unit,goalId:goal.goal.id,userInputRef,argsDigest:effectArgsDigest({request,userInputRef}),unitDigest:request.unitDigest,
    goalDigest:request.goalDigest,ledgerDigest:request.ledgerDigest,targetDigest:request.targetDigest,custodyDigest:request.custodyDigest,
    ownerDigest:effectArgsDigest(owner),policyDigest:effectArgsDigest(goal.policy)};
  await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.stopped-owner.recover',reason:request.reason});
  const proof = await adapters.provider.verifyStoppedOwnerRecovery({...binding,request:structuredClone(request),record:structuredClone(record),
    goal:structuredClone(goal),target:structuredClone(target),custody:structuredClone(custody)});
  if (proof?.verified !== true || Object.entries(binding).some(([key,value]) => proof[key] !== value))
    fail('source-backed closure and recovery authority is unverified','STOPPED_OWNER_UNPROVEN');
  await files();
  await assertReviewsSettled({stateRoot,store,goal,unit});
  if (effectArgsDigest(await adapters.git.inspectUnit({unit,record}) ?? null) !== request.targetDigest)
    fail('target changed during verification','STOPPED_OWNER_STALE');
  return {binding,observation:await observe()};
}

export async function recoverStoppedOwner({stateRoot,store,unit,request,userInputRef,adapters}) {
  const keys = ['id','expectedRevision','expectedGoalRevision','unitDigest','goalDigest','ledgerDigest','targetDigest','custodyDigest','owner','provenance','reason'];
  if (!request || Object.keys(request).sort().join(',') !== keys.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(value => Number.isSafeInteger(value) && value > 0)
    || !['unitDigest','goalDigest','ledgerDigest','targetDigest','custodyDigest'].every(key => sha(request[key]))
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,ref' || !sha(request.provenance.digest)
    || !text(request.provenance.ref) || !text(request.reason) || !text(userInputRef)) fail('exact recovery request and sourced authority are required');
  return createLedgerStore(stateRoot).withLock(unit, ledger => store.withLock(unit, async record => {
    const goals = createContinuityStore(stateRoot), rows = await ledger.read();
    if (!record.continuity?.goalId) fail('goal-bound stopped unit required');
    let receipt;
    await goals.transaction(record.continuity.goalId, async goal => {
      const prior = goal?.stoppedOwnerRecoveries?.find(item => item.id === request.id);
      const requestDigest = effectArgsDigest({request,userInputRef});
      if (prior && (prior.unit !== unit || prior.requestDigest !== requestDigest || stoppedOwnerRecovery(goal,unit) !== prior))
        fail('recovery id or custody has conflicting history','STOPPED_OWNER_CONFLICT');
      const before = prior ? originalGoal(goal,prior,false) : goal;
      const verified = await verifyStoppedOwner({stateRoot,store,record,goal:before,rows,request,userInputRef,adapters});
      if (prior) {receipt = {...prior,duplicate:true}; return goal;}
      const retiredCustodyDigests = ['adoptions','rebindings','bootstraps','transfers'].flatMap(field => (goal[field] ?? [])
        .filter(item => field === 'transfers' ? item.successor === unit : item.unit === unit).map(effectArgsDigest));
      receipt = {id:request.id,unit,kind:'external-closure-observation',request:structuredClone(request),userInputRef,requestDigest,
        ...verified,retiredCustodyDigests,goalRevision:goal.revision+1,blocker:goal.goal.blocker,
        hadRecoveries:Object.hasOwn(goal,'stoppedOwnerRecoveries'),hadBlockerHistory:Object.hasOwn(goal,'blockerHistory')};
      return {...goal,revision:goal.revision+1,stoppedOwnerRecoveries:[...(goal.stoppedOwnerRecoveries ?? []),receipt]};
    });
    return receipt;
  }));
}

export async function verifyRecoveredStop({stateRoot,store,record,goal,rows,adapters,resumed = false}) {
  const receipt = stoppedOwnerRecovery(goal,record.unit);
  if (!receipt) fail('stopped owner closure must be verified','SESSION_CLOSE_PENDING');
  const before = originalGoal(goal,receipt,resumed);
  await verifyStoppedOwner({stateRoot,store,record,goal:before,rows,request:receipt.request,userInputRef:receipt.userInputRef,adapters});
  return {mode:'stopped-observation',recovery:receipt,stopReport:record.stopReport};
}

export async function resumeStoppedGoal({stateRoot,store,id,request,adapters}) {
  return createLedgerStore(stateRoot).withLock(request.unit, ledger => store.withLock(request.unit, async record => {
    if (record.continuity?.goalId !== id || record.state !== 'Stopped') fail('goal resume requires its stopped unit');
    const rows = await ledger.read();
    return createContinuityStore(stateRoot).transaction(id, async goal => {
      if (!record.sessionFinalization?.closeReceipt?.result?.closed)
        await verifyRecoveredStop({stateRoot,store,record,goal,rows,adapters});
      return resumeGoal(goal,request);
    });
  }));
}
