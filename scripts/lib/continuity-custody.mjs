import path from 'node:path';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { createLedgerStore, sessionStartRetired } from './ledger.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';

const fail = (message, code = 'CUSTODY_INVALID') => { throw Object.assign(new Error(message), {code}); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const unresolved = rows => rows.some(row=>row.event === 'intent' && !sessionStartRetired(rows,row) && !rows.some(result=>result.event === 'result' && result.seq === row.seq && result.key === row.key
  && !['unknown','uncertain'].includes(result.result?.status)));
export const goalOwner = (goal, unit) => goal?.rebindings?.findLast(item => item.unit === unit) ?? goal?.adoptions?.findLast(item => item.unit === unit)
  ?? goal?.bootstraps?.findLast(item => item.unit === unit) ?? goal?.transfers?.find(item => item.successor === unit);

// Only identity fields enter the fence; transient UI/process observation metadata is not authority.
export function nativeOwner(owner) {
  if (!['cmux','orca'].includes(owner?.runtime) || !text(owner.sessionId) || !text(owner.incarnationId)
    || !path.isAbsolute(owner.cwd ?? '') || !text(owner.worker?.executable) || !text(owner.worker?.incarnationId)
    || !Number.isSafeInteger(owner.worker?.pid) || owner.worker.pid < 1 || !text(owner.worker?.threadId)) fail('exact native owner is unavailable');
  const {runtime,sessionId,incarnationId,cwd} = owner;
  const {executable,pid,threadId} = owner.worker;
  return {runtime,sessionId,incarnationId,cwd,worker:{executable,pid,threadId,incarnationId:owner.worker.incarnationId}};
}
export function assertAdoptedOwner(custody, observed) {
  if (custody?.ownership === 'existing' && effectArgsDigest(nativeOwner(observed)) !== effectArgsDigest(custody.owner))
    fail('adopted native owner changed', 'SESSION_OWNER_MISMATCH');
}
async function verifySource(source) {
  if (!path.isAbsolute(source?.path ?? '') || !sha(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest)
    fail('canonical source changed', 'CUSTODY_STALE');
}
async function assertReviewsSettled({stateRoot,store,goal,unit}) {
  const reviews = new Set((goal.reviews ?? []).filter(item=>item.targetUnit === unit).map(item=>item.unit));
  for (const entry of await readdir(path.join(stateRoot,'units'),{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const candidate = await store.read(entry.name);
    if (candidate?.kind === 'review' && candidate.targetUnit === unit && candidate.continuity?.goalId === goal.goal.id) reviews.add(candidate.unit);
  }
  for (const id of reviews) {
    const reviewer = await store.read(id);
    if (reviewer?.state !== 'Closed' || !reviewer.sessionFinalization?.closeReceipt?.result?.closed)
      fail('reviewer must return and close before rebind','CUSTODY_CONFLICT');
    if (unresolved(await createLedgerStore(stateRoot).withLock(id,ledger=>ledger.read())))
      fail('reconcile uncertain reviewer effects before rebind','EFFECT_UNCERTAIN');
  }
}
export async function adoptGoalSession({stateRoot,store,unit,request,userInputRef,adapters,cwd,rebind = false}) {
  const keys = ['id','expectedRevision','expectedGoalRevision','unitDigest','goalDigest','targetDigest','owner','provenance','reason',...(rebind ? ['previousCustodyDigest'] : [])];
  if (!request || Object.keys(request).sort().join(',') !== keys.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(value=>Number.isSafeInteger(value) && value > 0)
    || ![request.unitDigest,request.goalDigest,request.targetDigest,request.provenance?.digest,...(rebind ? [request.previousCustodyDigest] : [])].every(sha)
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,ref' || !text(request.provenance?.ref) || !text(request.reason) || !text(userInputRef)) fail('exact adoption request, provenance and user input are required');
  const owner = nativeOwner(request.owner);
  if (!cwd || await realpath(cwd) !== owner.cwd) fail('adoption must run in the exact owner cwd');
  if (effectArgsDigest(owner) !== effectArgsDigest(request.owner)) fail('owner must contain only exact native identity fields');
  const verifier = rebind ? 'verifySessionRebind' : 'verifySessionAdoption';
  if (typeof adapters.session?.observe !== 'function' || typeof adapters.git?.inspectUnit !== 'function'
    || typeof adapters.provider?.[verifier] !== 'function') fail('trusted session, Git and custody verifiers are required','ADAPTER_MISSING');
  const goals = createContinuityStore(stateRoot), requestDigest = effectArgsDigest({request,userInputRef});
  return createLedgerStore(stateRoot).withLock(unit, async ledger => store.withLock(unit, async record => {
    if (!record.continuity?.goalId || ['review','ops'].includes(record.kind)
      || !['Scoped','Implementing','SelfGated','InReview','Accepted'].includes(record.state)
      || record.sessionFinalization || record.deliveryPlan || record.deliveryResult) fail('active goal-bound change unit required');
    const rows = await ledger.read();
    if (unresolved(rows)) fail('reconcile uncertain effects before adoption','EFFECT_UNCERTAIN');
    let receipt;
    await goals.transaction(record.continuity.goalId, async goal => {
      const field = rebind ? 'rebindings' : 'adoptions';
      const prior = goal?.[field]?.find(item=>item.id === request.id);
      if (prior && prior.requestDigest !== requestDigest) fail('adoption id already binds another request','CUSTODY_CONFLICT');
      if (!goal || goal.goal.status !== 'active' || goal.goal.remaining[0] !== unit) fail('unit must be the current active goal target');
      if (prior && effectArgsDigest(goalOwner(goal,unit)) !== effectArgsDigest(prior)) fail('custody has been superseded','CUSTODY_CONFLICT');
      if (!rebind && !prior && (goalOwner(goal,unit) || record.sessionHistory?.length || (goal.reviews ?? []).some(item=>item.targetUnit === unit)))
        fail('unit already has registered session custody','CUSTODY_CONFLICT');
      let previous;
      if (rebind) {
        const current = goalOwner(goal,unit);
        previous = prior ? [...(goal.adoptions ?? []),...(goal.rebindings ?? [])].find(item=>effectArgsDigest(item) === request.previousCustodyDigest) : current;
        if (current?.ownership !== 'existing' || previous?.ownership !== 'existing' || previous.unit !== unit
          || effectArgsDigest(previous) !== request.previousCustodyDigest)
          fail('previous existing custody changed','CUSTODY_CONFLICT');
        const old = nativeOwner(previous.owner);
        if (['runtime','sessionId','cwd'].some(key=>old[key] !== owner[key]) || old.worker.threadId !== owner.worker.threadId
          || path.basename(old.worker.executable) !== path.basename(owner.worker.executable)
          || old.worker.pid === owner.worker.pid || owner.runtime === 'cmux' && old.worker.incarnationId === owner.worker.incarnationId)
          fail('replacement must resume the same native owner thread','SESSION_OWNER_MISMATCH');
        if (previous.policyDigest !== effectArgsDigest(goal.policy)) fail('previous owner execution policy changed','CUSTODY_STALE');
        await assertReviewsSettled({stateRoot,store,goal,unit});
        if (prior) {
          const before = {...goal,revision:request.expectedGoalRevision};
          if (prior.hadRebindings) before.rebindings = goal.rebindings.slice(0,-1);
          else delete before.rebindings;
          if (goal.revision !== request.expectedGoalRevision+1 || effectArgsDigest(before) !== request.goalDigest)
            fail('goal changed after rebind','CUSTODY_STALE');
        }
      }
      if (record.revision !== request.expectedRevision || effectArgsDigest(record) !== request.unitDigest
        || (!prior && (goal.revision !== request.expectedGoalRevision || effectArgsDigest(goal) !== request.goalDigest))) fail('unit or goal changed','CUSTODY_STALE');
      await verifySource(goal.source);
      for (const source of record.canon ?? []) await verifySource({...source,path:path.resolve(cwd,source.path ?? '')});
      const execution = selectExecutionPolicy(goal.policy,'implementation');
      if (owner.runtime !== execution.runtime || path.basename(owner.worker.executable) !== execution.provider) fail('owner runtime or provider differs from current goal policy');
      if (prior && prior.policyDigest !== effectArgsDigest(goal.policy)) fail('goal policy changed','CUSTODY_STALE');
      const target = await adapters.git.inspectUnit({unit,record});
      if (effectArgsDigest(target ?? null) !== request.targetDigest
        || record.head && (record.head !== target?.head || record.contentFingerprint !== target?.contentFingerprint)) fail('adoption target changed','CUSTODY_STALE');
      const observe = async () => {
        const observation = await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd,...(rebind ? {previousOwner:structuredClone(previous.owner)} : {})});
        if (rebind && observation.previousOwnerAbsent !== true) fail('previous owner absence is unproven','CUSTODY_UNPROVEN');
        const observed = nativeOwner(observation);
        if (effectArgsDigest(observed) !== effectArgsDigest(owner)) fail('actual native owner differs from request','SESSION_OWNER_MISMATCH');
      };
      await observe();
      const binding = {unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:request.unitDigest,goalDigest:request.goalDigest,
        targetDigest:request.targetDigest,ownerDigest:effectArgsDigest(owner),policyDigest:effectArgsDigest(goal.policy),...(rebind ? {previousCustodyDigest:request.previousCustodyDigest} : {})};
      await verifyApprovalInput(adapters.provider,{...binding,effect:rebind ? 'unit.session.rebind' : 'unit.session.adopt',reason:request.reason});
      const verified = await adapters.provider[verifier]({...binding,request:structuredClone(request),record:structuredClone(record),goal:structuredClone(goal),target:structuredClone(target),...(rebind ? {previousCustody:structuredClone(previous)} : {})});
      if (verified?.verified !== true || Object.entries(binding).some(([key,value])=>verified[key] !== value)) fail('source-backed adoption permission is unverified','CUSTODY_UNPROVEN');
      await verifySource(goal.source);
      for (const source of record.canon ?? []) await verifySource({...source,path:path.resolve(cwd,source.path ?? '')});
      if (effectArgsDigest(await adapters.git.inspectUnit({unit,record}) ?? null) !== request.targetDigest) fail('target changed during adoption','CUSTODY_STALE');
      if (rebind) await assertReviewsSettled({stateRoot,store,goal,unit});
      await observe();
      if (prior) { receipt = {...prior,duplicate:true}; return goal; }
      receipt = {id:request.id,unit,ownership:'existing',...owner,owner,request:structuredClone(request),userInputRef,requestDigest,
        policyDigest:binding.policyDigest,goalRevision:goal.revision+1,...(rebind ? {previousCustodyDigest:request.previousCustodyDigest,hadRebindings:Object.hasOwn(goal,'rebindings')} : {})};
      return {...goal,revision:goal.revision+1,[field]:[...(goal[field] ?? []),receipt]};
    });
    return receipt;
  }));
}
