import { effectArgsDigest } from './approvals.mjs';
import { goalOwner, assertAdoptedOwner } from './continuity-custody.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createContinuityStore } from './continuity-store.mjs';
import { snapshotGoal } from './continuity-snapshot.mjs';
import { loadManagedLaunch } from './continuity-launch-io.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';
import { validateHandoffPacket } from './report.mjs';
import { createLedgerStore, executeEffect } from './ledger.mjs';
import { validateTaskReceipt } from './session-task.mjs';
import { resolvePolicy } from './policy.mjs';

const failure = message => Object.assign(new Error(message), {code:'CONTINUITY_INVALID'});
export async function startGoalSession({ stateRoot, unit, request, store, adapters }) {
  const record = await store.read(unit);
  const review = record?.kind === 'review';
  if (review && record && !record.continuity?.goalId) throw failure('review unit is not bound to a goal: create it with goalId in the unit start request ({kind: "review", targetUnit, goalId})');
  if (!record?.continuity?.goalId || !(review ? record.state === 'InReview' : ['Scoped','Implementing'].includes(record.state))) throw failure('unit must be active and bound to a goal');
  const goals = createContinuityStore(stateRoot);
  const goal = await goals.read(record.continuity.goalId);
  if (!goal || goal.goal.status !== 'active' || goal.goal.remaining[0] !== (review ? record.targetUnit : unit)) throw failure('unit is not outstanding in an active goal');
  const attempt = (record.sessionHistory?.length ?? 0) + 1;
  if (!review && (goal.adoptions?.some(item => item.unit === unit) || attempt === 1 && (goal.transfers ?? []).some(item => item.successor === unit))) throw failure('successor already has a recorded owner');
  const source = await readFile(goal.source.path);
  if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== goal.source.digest) throw failure('goal source changed');
  if (!request || !path.isAbsolute(request.cwd ?? '') || !path.isAbsolute(request.handoffPath ?? '') || !/^sha256:[a-f0-9]{64}$/.test(request.handoffDigest ?? '')) throw failure('absolute cwd and immutable handoff are required');
  const handoff = await readFile(request.handoffPath, 'utf8');
  if (`sha256:${createHash('sha256').update(handoff).digest('hex')}` !== request.handoffDigest) throw failure('handoff digest changed');
  validateHandoffPacket(handoff);
  if (!adapters.session || typeof adapters.session.observe !== 'function') throw Object.assign(new Error('session adapter unavailable'),{code:'ADAPTER_MISSING'});
  const targetCustody = review ? goalOwner(goal, record.targetUnit) : null;
  const targetRecord = targetCustody?.ownership === 'existing' ? await store.read(record.targetUnit) : null;
  if (targetCustody?.ownership === 'existing' && (!targetRecord || targetRecord.state !== 'InReview')) throw failure('adopted review target must be InReview');
  const priorIntent = targetRecord ? await createLedgerStore(stateRoot).withLock(unit, async ledger =>
    (await ledger.read()).findLast(row => row.event === 'intent' && row.effect === 'session.start' && row.args?.unit === unit && row.args?.attempt === attempt)) : null;
  const entries = review ? goal.reviews : goal.bootstraps;
  const previousBootstrap = entries?.find(item => item.unit === unit && (item.attempt ?? 1) === attempt);
  const goalSnapshot = previousBootstrap ? {path:previousBootstrap.goalPath,digest:previousBootstrap.goalDigest} : priorIntent ? {path:priorIntent.args.goalPath,digest:priorIntent.args.goalDigest} : await snapshotGoal(stateRoot, goal);
  const args = {unit,role:review ? 'review' : 'implementation',attempt,cwd:request.cwd,handoffPath:request.handoffPath,handoffDigest:request.handoffDigest,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest,...(targetRecord ? {targetDigest:effectArgsDigest(targetRecord)} : {})};
  await loadManagedLaunch(args);
  if (priorIntent) {
    const original = JSON.parse(await readFile(goalSnapshot.path,'utf8'));
    if (priorIntent.args.targetDigest !== args.targetDigest || effectArgsDigest(original.goal) !== effectArgsDigest(goal.goal) || effectArgsDigest(original.policy) !== effectArgsDigest(goal.policy) || effectArgsDigest(original.source) !== effectArgsDigest(goal.source))
      throw failure('existing reviewer intent must retain its original source and execution policy');
  }
  const {policy} = resolvePolicy({unit:record.policyOverrides ?? {},project:record.policy ?? {}},{nonInteractive:true});
  const owner = await adapters.session.observe({cwd:request.parentRuntime?.cwd,targetCwd:request.cwd});
  if (owner.runtime !== selectExecutionPolicy(goal.policy,args.role).runtime) throw failure('configured session runtime differs from execution policy');
  if (!request.parentRuntime || owner.sessionId !== request.parentRuntime.sessionId || owner.incarnationId !== request.parentRuntime.incarnationId || owner.cwd !== request.parentRuntime.cwd) throw failure('session owner differs from request');
  if (review) {
    const target = goalOwner(goal, record.targetUnit);
    if (!target || target.sessionId !== owner.sessionId || target.incarnationId !== owner.incarnationId || target.cwd !== owner.cwd)
      throw failure('independent review must be launched by its target owner');
  }
  let lockedGoal, lockedTarget, registeredGoal;
  const boundary = async action => {
    if (!targetRecord) return action();
    if (typeof adapters.git?.inspectUnit !== 'function') throw failure('review launch requires live Git inspection');
    const live = await adapters.git.inspectUnit({unit:record.targetUnit,record:lockedTarget});
    if (live?.head !== lockedTarget.head || live?.contentFingerprint !== lockedTarget.contentFingerprint) throw failure('review target content changed');
    const source = await readFile(lockedGoal.source.path);
    if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== lockedGoal.source.digest) throw failure('goal source changed');
    assertAdoptedOwner(goalOwner(lockedGoal,record.targetUnit), await adapters.session.observe({cwd:owner.cwd,targetCwd:request.cwd}));
    return action();
  };
  const validate = (result, input) => {
    if (result?.sessionId === owner.sessionId || targetCustody?.ownership === 'existing' && result?.task?.threadId === targetCustody.owner.worker.threadId) throw failure('successor must be distinct');
    // A worker transport that observes its hooks (Codex) must report them verified; one that cannot observe them
    // (Claude) records no enforcement and relies on the host-enabled, trusted Stop hook.
    return validateTaskReceipt(result,input,{requireEnforcement:result?.task?.enforcement !== undefined});
  };
  const start = () => executeEffect({unit,effect:'session.start',args,policy,context:{explicitUserInstruction:true,productOwned:true},store:createLedgerStore(stateRoot),adapter:{
    now:adapters.now,
    async execute(input) { return boundary(async () => validate(await adapters.session.execute(input), input)); },
    async verify(input) { const observed = await boundary(() => adapters.session.verify(input)); if (observed.status === 'completed') { try { validate(observed.result,input); } catch (error) { return {status:'unknown',verify:{code:'RECEIPT_INVALID',message:error.message}}; } } return observed; },
  }});
  const perform = async () => {
    // A new worker often has not produced a verifiable receipt yet. Re-observe the same intent for a bounded time so the
    // owner's call itself records the registration; returning early left owner and reviewer waiting on each other.
    const waitSeconds = Number.isSafeInteger(request.waitSeconds) && request.waitSeconds >= 0 ? Math.min(request.waitSeconds, 900) : 180;
    const intervalSeconds = 10;
    const sleep = adapters.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let result = await start();
    // Only a start that has not produced a receipt yet is worth waiting for; a receipt that fails validation is final.
    for (let waited = 0; result.status === 'uncertain' && result.verification?.code !== 'RECEIPT_INVALID' && waited < waitSeconds; waited += intervalSeconds) {
      await sleep(intervalSeconds * 1000);
      result = await start();
    }
    if (!['completed','duplicate','reconciled'].includes(result.status)) return result;
    if (targetRecord) await boundary(async () => {});
    const register = current => {
      const field = review ? 'reviews' : 'bootstraps';
      const previous = current?.[field]?.find(item => item.unit === unit && (item.attempt ?? 1) === attempt);
      if (previous) { if (previous.effectKey !== result.key || previous.sessionId !== result.result.sessionId || previous.incarnationId !== result.result.incarnationId || previous.cwd !== result.result.cwd) throw failure('goal bootstrap differs'); return current; }
      if (!current || current.revision !== goal.revision) throw failure('goal changed during bootstrap');
      return {...current,revision:current.revision+1,[field]:[...(current[field] ?? []),{unit,attempt,...(review ? {targetUnit:record.targetUnit,...(targetRecord ? {targetDigest:args.targetDigest,nativeThreadId:result.result.task.threadId} : {})} : {}),effectKey:result.key,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest,sessionId:result.result.sessionId,incarnationId:result.result.incarnationId,cwd:result.result.cwd}]};
    };
    if (targetRecord) registeredGoal = register(lockedGoal);
    else await goals.transaction(goal.goal.id, register);
    return result;
  };
  if (!targetRecord) return perform();
  // Hold target and goal custody through the native effect, durable ledger result and owner registration.
  return store.withLock(record.targetUnit, async currentTarget => {
    let result;
    await goals.transaction(goal.goal.id, async currentGoal => {
      if (effectArgsDigest(currentTarget) !== effectArgsDigest(targetRecord) || currentGoal?.revision !== goal.revision)
        throw failure('review target or goal changed before session effect');
      lockedGoal = currentGoal; lockedTarget = currentTarget;
      result = await perform();
      return registeredGoal ?? currentGoal;
    });
    return result;
  });
}
