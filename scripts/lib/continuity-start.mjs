import { effectArgsDigest } from './approvals.mjs';
import { goalOwner, assertAdoptedOwner } from './continuity-custody.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createContinuityStore } from './continuity-store.mjs';
import { snapshotGoal } from './continuity-snapshot.mjs';
import { loadManagedLaunch } from './continuity-launch-io.mjs';
import { selectExecutionPolicy, executionPoliciesEqual } from './continuity-decision.mjs';
import { validateHandoffPacket } from './report.mjs';
import { createLedgerStore, executeEffect, unresolvedEffect } from './ledger.mjs';
import { validateTaskReceipt } from './session-task.mjs';
import { resolvePolicy, prepareEffect } from './policy.mjs';

const failure = message => Object.assign(new Error(message), {code:'CONTINUITY_INVALID'});
export async function startGoalSession({ stateRoot, unit, request, store, adapters }) {
  return createLedgerStore(stateRoot).withLock(unit, ledger => store.withLock(unit, async record => {
    if (record.kind === 'review' && !record.continuity?.goalId) throw failure('review unit is not bound to a goal: create it with goalId in the unit start request');
    const goals = createContinuityStore(stateRoot);
    const before = record.continuity?.goalId ? await goals.read(record.continuity.goalId) : null;
    const target = record.kind === 'review' && goalOwner(before, record.targetUnit)?.ownership === 'existing';
    const run = targetRecord => goals.transaction(before.goal.id, async goal => {
      if (goal?.revision !== before.revision) throw failure('goal changed before session start');
      const outcome = await startLocked({stateRoot,unit,request,store,adapters,record,goal,ledger,targetRecord});
      result = outcome.result;
      return outcome.goal;
    });
    let result;
    if (!before) throw failure('unit must be bound to a goal');
    if (target) await store.withLock(record.targetUnit, run);
    else await run(null);
    return result;
  }));
}

async function startLocked({stateRoot,unit,request,store,adapters,record,goal,ledger,targetRecord}) {
  const review = record?.kind === 'review';
  const recovered = record.sessionHistory?.at(-1);
  const normallyStopped = recovered?.mode === 'stopped';
  const recoveredActive = (normallyStopped || recovered?.mode === 'stopped-observation'
    && effectArgsDigest(recovered.recovery) === effectArgsDigest(goal?.stoppedOwnerRecoveries?.findLast(item => item.unit === unit)))
    && ['SelfGated','InReview','Accepted'].includes(record.state);
  if (review && record && !record.continuity?.goalId) throw failure('review unit is not bound to a goal: create it with goalId in the unit start request ({kind: "review", targetUnit, goalId})');
  if (!record?.continuity?.goalId || !(review ? record.state === 'InReview' : ['Scoped','Implementing'].includes(record.state) || recoveredActive)) throw failure('unit must be active and bound to a goal');
  if (!goal || goal.goal.status !== 'active' || goal.goal.remaining[0] !== (review ? record.targetUnit : unit)) throw failure('unit is not outstanding in an active goal');
  const rows = await ledger.read();
  const reservation = rows.findLast(row => row.event === 'session-start-recovery');
  const historyLength = record.sessionHistory?.length ?? 0;
  const attempt = Math.max(historyLength + 1, reservation ? (reservation.nextArgs?.attempt ?? reservation.nextAttempt) + historyLength - reservation.sessionHistoryLength : 1);
  const currentOwner = goalOwner(goal,unit);
  if (!review && (currentOwner?.ownership === 'existing' || attempt === 1 && currentOwner?.successor === unit)) throw failure('successor already has a recorded owner');
  const source = await readFile(goal.source.path);
  if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== goal.source.digest) throw failure('goal source changed');
  if (!request || !path.isAbsolute(request.cwd ?? '') || !path.isAbsolute(request.handoffPath ?? '') || !/^sha256:[a-f0-9]{64}$/.test(request.handoffDigest ?? '')) throw failure('absolute cwd and immutable handoff are required');
  const handoff = await readFile(request.handoffPath, 'utf8');
  if (`sha256:${createHash('sha256').update(handoff).digest('hex')}` !== request.handoffDigest) throw failure('handoff digest changed');
  validateHandoffPacket(handoff);
  if (!adapters.session || typeof adapters.session.observe !== 'function') throw Object.assign(new Error('session adapter unavailable'),{code:'ADAPTER_MISSING'});
  if (normallyStopped) await verifyStoppedClosure({record,goal,rows,unit,attempt,adapters});
  const targetCustody = review ? goalOwner(goal, record.targetUnit) : null;
  if (targetCustody?.ownership === 'existing' && (!targetRecord || targetRecord.state !== 'InReview')) throw failure('adopted review target must be InReview');
  const priorIntent = rows.findLast(row => row.event === 'intent' && row.effect === 'session.start' && row.args?.unit === unit && row.args?.attempt === attempt);
  const boundArgs = priorIntent?.args ?? (reservation?.nextArgs?.attempt === attempt ? reservation.nextArgs : null);
  const {policy} = resolvePolicy({unit:record.policyOverrides ?? {},project:record.policy ?? {}},{nonInteractive:true});
  if (review && targetCustody?.ownership === 'existing' && !boundArgs && !executionPoliciesEqual(policy.session, goal.policy))
    throw Object.assign(new Error('fresh review execution policy differs from the current goal'), {code:'CONTINUITY_STALE'});
  const entries = review ? goal.reviews : goal.bootstraps;
  const previousBootstrap = entries?.find(item => item.unit === unit && (item.attempt ?? 1) === attempt);
  const goalSnapshot = boundArgs ? {path:boundArgs.goalPath,digest:boundArgs.goalDigest} : previousBootstrap ? {path:previousBootstrap.goalPath,digest:previousBootstrap.goalDigest} : await snapshotGoal(stateRoot, goal);
  const args = {unit,role:review ? 'review' : 'implementation',attempt,cwd:request.cwd,handoffPath:request.handoffPath,handoffDigest:request.handoffDigest,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest,...(targetRecord ? {targetDigest:effectArgsDigest(targetRecord)} : {})};
  if (boundArgs && effectArgsDigest(boundArgs) !== effectArgsDigest(args)) throw Object.assign(new Error('session start requires its original complete arguments'),{code:'EFFECT_UNCERTAIN'});
  await loadManagedLaunch(args);
  if (boundArgs) {
    const original = JSON.parse(await readFile(goalSnapshot.path,'utf8'));
    if (boundArgs.targetDigest !== args.targetDigest || effectArgsDigest(original.goal) !== effectArgsDigest(goal.goal) || effectArgsDigest(original.source) !== effectArgsDigest(goal.source))
      throw failure('existing intent must retain its original source and target');
  }
  const owner = await adapters.session.observe({cwd:request.parentRuntime?.cwd,targetCwd:request.cwd});
  const original = JSON.parse(await readFile(goalSnapshot.path,'utf8'));
  if (owner.runtime !== selectExecutionPolicy(original.policy,args.role).runtime) throw failure('configured session runtime differs from original execution policy');
  if (!request.parentRuntime || owner.sessionId !== request.parentRuntime.sessionId || owner.incarnationId !== request.parentRuntime.incarnationId || owner.cwd !== request.parentRuntime.cwd) throw failure('session owner differs from request');
  if (review) {
    const target = goalOwner(goal, record.targetUnit);
    if (!target || target.sessionId !== owner.sessionId || target.incarnationId !== owner.incarnationId || target.cwd !== owner.cwd)
      throw failure('independent review must be launched by its target owner');
  }
  let registeredGoal = goal;
  const boundary = async action => {
    if (normallyStopped) await verifyStoppedClosure({record,goal,rows:await ledger.read(),unit,attempt,adapters});
    const source = await readFile(goal.source.path);
    if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== goal.source.digest) throw failure('goal source changed');
    await loadManagedLaunch(args);
    if (!targetRecord) return action();
    if (typeof adapters.git?.inspectUnit !== 'function') throw failure('review launch requires live Git inspection');
    const live = await adapters.git.inspectUnit({unit:record.targetUnit,record:targetRecord});
    if (live?.head !== targetRecord.head || live?.contentFingerprint !== targetRecord.contentFingerprint) throw failure('review target content changed');
    assertAdoptedOwner(goalOwner(goal,record.targetUnit), await adapters.session.observe({cwd:owner.cwd,targetCwd:request.cwd}));
    return action();
  };
  const validate = (result, input) => {
    if (result?.sessionId === owner.sessionId || targetCustody?.ownership === 'existing' && result?.task?.threadId === targetCustody.owner.worker.threadId) throw failure('successor must be distinct');
    // A worker transport that observes its hooks (Codex) must report them verified; one that cannot observe them
    // (Claude) records no enforcement and relies on the host-enabled, trusted Stop hook.
    return validateTaskReceipt(result,input,{requireEnforcement:result?.task?.enforcement !== undefined});
  };
  const start = () => executeEffect({unit,effect:'session.start',args,policy,context:{explicitUserInstruction:true,productOwned:true},store:{withLock:async (_unit,action)=>action(ledger)},adapter:{
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
    await boundary(async () => {});
    const register = current => {
      const field = review ? 'reviews' : 'bootstraps';
      const previous = current?.[field]?.find(item => item.unit === unit && (item.attempt ?? 1) === attempt);
      if (previous) { if (previous.effectKey !== result.key || previous.sessionId !== result.result.sessionId || previous.incarnationId !== result.result.incarnationId || previous.cwd !== result.result.cwd) throw failure('goal bootstrap differs'); return current; }
      if (!current || current.revision !== goal.revision) throw failure('goal changed during bootstrap');
      return {...current,revision:current.revision+1,[field]:[...(current[field] ?? []),{unit,attempt,...(review ? {targetUnit:record.targetUnit,...(targetRecord ? {targetDigest:args.targetDigest,nativeThreadId:result.result.task.threadId} : {})} : {}),effectKey:result.key,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest,sessionId:result.result.sessionId,incarnationId:result.result.incarnationId,cwd:result.result.cwd}]};
    };
    registeredGoal = register(goal);
    return result;
  };
  const result = await perform();
  return {result:{...result,intent:{seq:result.seq,key:result.key,argsDigest:effectArgsDigest(args)}},goal:registeredGoal};
}

async function verifyStoppedClosure({record,goal,rows,unit,attempt,adapters}) {
  const plan = record.sessionHistory.at(-1), receipt = plan.closeReceipt;
  const owner = plan.owner;
  const prior = [...(goal.bootstraps ?? []),...(goal.transfers ?? []).filter(item => item.successor === unit)]
    .findLast(item => (item.unit === unit || item.successor === unit) && (item.attempt ?? 1) === attempt - 1);
  const sameOwner = value => value?.sessionId === owner?.sessionId && value?.incarnationId === owner?.incarnationId && value?.cwd === owner?.cwd;
  const current = goalOwner(goal,unit);
  const registered = goal.bootstraps?.find(item => item.unit === unit && item.attempt === attempt);
  if (!owner || !sameOwner(prior) || !(sameOwner(current) || registered && current === registered) || plan.retainedOwner || !['completed','duplicate','reconciled'].includes(receipt?.status)
    || receipt.result?.closed !== true || receipt.result.sessionId !== owner.sessionId || receipt.result.incarnationId !== owner.incarnationId)
    throw failure('normal stopped closure does not match historical custody');
  const intent = rows.find(row => row.event === 'intent' && row.effect === 'session.close' && row.unit === unit && row.key === receipt.key && row.seq === receipt.seq);
  const result = rows.findLast(row => row.event === 'result' && row.key === receipt.key && row.seq === receipt.seq);
  const delivery = rows.find(row => row.event === 'intent' && row.effect === 'session.deliver' && row.key === intent?.args.deliveryKey && row.unit === unit);
  if (!intent || !delivery || delivery.args.resultDigest !== plan.resultDigest
    || delivery.args.handoffDigest !== plan.handoffDigest || delivery.args.goalDigest !== plan.goalDigest
    || prepareEffect('session.close',intent.args).key !== receipt.key
    || effectArgsDigest(intent.args.owner) !== effectArgsDigest(owner)
    || intent.args.session !== owner.sessionId || intent.args.incarnation !== owner.incarnationId
    || intent.args.resultDigest !== plan.resultDigest || effectArgsDigest(intent.args.recipient) !== effectArgsDigest(plan.recipient)
    || !result || effectArgsDigest(result.result) !== effectArgsDigest(receipt.result)
    || !rows.some(row => row.event === 'result' && row.key === intent.args.deliveryKey))
    throw failure('normal stopped closure ledger is incomplete or stale');
  const currentStart = rows.findLast(row => row.event === 'intent' && row.effect === 'session.start' && row.unit === unit
    && row.args?.unit === unit && row.args?.attempt === attempt);
  if (unresolvedEffect(rows.filter(row => row !== currentStart)))
    throw failure('unresolved effects prevent stopped owner startup');
  const observed = await adapters.session.observe({closedOwner:owner});
  if (observed?.closed !== true || effectArgsDigest(observed.owner) !== effectArgsDigest(owner))
    throw failure('normal stopped owner closure is unproven');
}
