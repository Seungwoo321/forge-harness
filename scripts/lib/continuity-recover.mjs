import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createLedgerStore,sessionEffectRetired} from './ledger.mjs';
import {goalOwner} from './continuity-custody.mjs';
import {loadManagedLaunch} from './continuity-launch-io.mjs';
import {snapshotGoal} from './continuity-snapshot.mjs';
import {prepareEffect} from './policy.mjs';
import {selectExecutionPolicy,executionPoliciesEqual} from './continuity-decision.mjs';

const fail = (message,code='SESSION_RECOVERY_INVALID') => {throw Object.assign(new Error(message),{code});};
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim();
async function checkFile(source) {
  if (!path.isAbsolute(source?.path ?? '') || !digest(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest) fail('immutable source changed','CONTINUITY_STALE');
}

// This only reserves a new attempt. It never launches a worker or fabricates an old effect result.
export async function recoverGoalSession({stateRoot,unit,request,userInputRef,store,adapters}) {
  const fields=['id','expectedRevision','expectedGoalRevision','intent','provenance','reason'];
  if (!request || Object.keys(request).sort().join(',') !== fields.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n) && n>0)
    || Object.keys(request.intent ?? {}).sort().join(',') !== 'argsDigest,key,seq'
    || !digest(request.intent.key) || !digest(request.intent.argsDigest) || !Number.isSafeInteger(request.intent.seq) || request.intent.seq<1
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,path'
    || !path.isAbsolute(request.provenance.path ?? '') || !digest(request.provenance.digest)
    || !text(request.reason) || !text(userInputRef)) fail('exact recovery request, revisions, intent, provenance and user input are required');
  const requestDigest=effectArgsDigest({request,userInputRef});
  const goals=createContinuityStore(stateRoot);
  return createLedgerStore(stateRoot).withLock(unit, ledger=>store.withLock(unit,async record=>{
    const rows=await ledger.read();
    const previous=rows.find(row=>row.event==='session-start-recovery' && row.id===request.id);
    if (previous) {
      if (previous.requestDigest!==requestDigest) fail('recovery id binds another request','SESSION_RECOVERY_CONFLICT');
      if (!previous.settled) return {...previous,duplicate:true};
    }
    const review=record.kind==='review';
    if (!record.continuity?.goalId || !(review ? record.state==='InReview' : ['Scoped','Implementing'].includes(record.state))
      || record.revision!==request.expectedRevision || record.sessionFinalization || record.deliveryPlan) fail('unit is stale or cannot recover startup','CONTINUITY_STALE');
    const intent=rows.findLast(row=>row.event==='intent' && row.effect==='session.start');
    if (!intent || intent.seq!==request.intent.seq || intent.key!==request.intent.key || effectArgsDigest(intent.args)!==request.intent.argsDigest
      || intent.args.unit!==unit || intent.args.role!==(review?'review':'implementation') || prepareEffect('session.start',intent.args).key!==intent.key
      || rows.some(row=>row.event==='session-start-recovery' && row.key===intent.key && row!==previous)
      || rows.some(row=>row.event==='result' && row.key===intent.key && row.seq===intent.seq)) fail('only the latest unresolved startup can be recovered','EFFECT_UNCERTAIN');
    if (rows.some(row=>row.event==='intent' && row!==intent && !sessionEffectRetired(rows,row)
      && !rows.some(done=>done.event==='result' && done.seq===row.seq && done.key===row.key))) fail('another effect remains uncertain','EFFECT_UNCERTAIN');
    const original=JSON.parse(await readFile(intent.args.goalPath,'utf8'));
    await loadManagedLaunch(intent.args);
    const before=await goals.read(record.continuity.goalId);
    const target=review && goalOwner(before,record.targetUnit)?.ownership==='existing';
    let receipt;
    const reserve=targetRecord=>goals.transaction(record.continuity.goalId,async goal=>{
      const settleOnly=review && goal?.goal.status==='blocked' && targetRecord?.state==='Stopped'
        && targetRecord.continuity?.goalId===goal.goal.id && goal.goal.blocker?.unit===record.targetUnit
        && targetRecord.stopReport && !targetRecord.deliveryPlan && !targetRecord.deliveryResult;
      if (!goal || goal.revision!==request.expectedGoalRevision || !(goal.goal.status==='active' || settleOnly)
        || goal.goal.remaining[0]!== (review?record.targetUnit:unit)
        || original.goal.id!==goal.goal.id || effectArgsDigest(original.source)!==effectArgsDigest(goal.source)) fail('goal changed or is not the current target','CONTINUITY_STALE');
      const owners=review?goal.reviews:goal.bootstraps;
      if (owners?.some(item=>item.unit===unit) || !review && goalOwner(goal,unit)) fail('startup already has a registered owner','SESSION_RECOVERY_CONFLICT');
      if (!settleOnly && executionPoliciesEqual(original.policy,goal.policy)) fail('execution policy must change before recovery');
      if (!settleOnly && intent.args.targetDigest!== (target?effectArgsDigest(targetRecord):undefined)) fail('review target changed','CONTINUITY_STALE');
      await checkFile(goal.source); await checkFile(request.provenance);
      if (typeof adapters.provider?.verifySessionStartRecovery!=='function') fail('trusted terminal non-start verifier is required','ADAPTER_MISSING');
      const nextAttempt=intent.args.attempt+1;
      if (!Number.isSafeInteger(nextAttempt)) fail('invalid next attempt');
      const snapshot=settleOnly?null:await snapshotGoal(stateRoot,goal);
      const nextArgs=settleOnly?null:{...intent.args,attempt:nextAttempt,goalPath:snapshot.path,goalDigest:snapshot.digest};
      if (nextArgs) await loadManagedLaunch(nextArgs);
      const submission=rows.findLast(row=>row.event==='submission' && row.seq===intent.seq && row.key===intent.key);
      if (typeof adapters.session?.verify === 'function') {
        let observed;
        try { observed=await adapters.session.verify({effect:'session.start',args:intent.args,key:intent.key,seq:intent.seq,
          submission:{attempted:Boolean(submission),binding:submission?.binding,confirmed:rows.some(row=>row.event==='confirmation' && row.key===intent.key && row.seq===intent.seq),readOnly:true,recovery:true}}); }
        catch { /* An unavailable receiver is not non-start proof; the trusted verifier below must prove it. */ }
        if (observed?.status==='completed') fail('original startup has a receipt; reconcile it instead','SESSION_RECOVERY_CONFLICT');
      }
      const binding={unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,intentDigest:effectArgsDigest(intent),
        submissionDigest:effectArgsDigest(submission ?? null),unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),
        nextArgsDigest:effectArgsDigest(nextArgs),provenanceDigest:request.provenance.digest,
        ...(settleOnly?{targetDigest:effectArgsDigest(targetRecord)}:{})};
      if (previous && ['unitDigest','goalDigest','targetDigest'].some(key=>binding[key]!==previous.proof[key]))
        fail('settled reviewer or target changed','CONTINUITY_STALE');
      await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.session.recover',reason:request.reason});
      // The provider reads original native history/account and proves irreversible receiver/queue quiescence.
      // It must not submit input, clear a goal, cancel work, terminate a receiver or infer success from the request.
      const proof=await adapters.provider.verifySessionStartRecovery({...binding,request:structuredClone(request),intent:structuredClone(intent),
        submission:structuredClone(submission ?? null),original:structuredClone(original),goal:structuredClone(goal),nextArgs:structuredClone(nextArgs),
        ...(settleOnly?{settleOnly:true,target:structuredClone(targetRecord)}:{})});
      if (proof?.verified!==true || Object.entries(binding).some(([key,value])=>proof[key]!==value)
        || proof.taskNeverStarted!==true || proof.receiverStopped!==true || proof.queueCancelled!==true
        || !text(proof.receiver?.sessionId) || !text(proof.receiver?.incarnationId) || !text(proof.receiver?.threadId)
        || !Number.isSafeInteger(proof.receiver?.pid) || proof.receiver.pid<1
        || proof.receiver.runtime!==selectExecutionPolicy(original.policy,intent.args.role).runtime
        || path.basename(proof.receiver.executable ?? '')!==selectExecutionPolicy(original.policy,intent.args.role).provider
        || proof.receiver.cwd!==intent.args.cwd || proof.evidenceDigest!==request.provenance.digest) fail('terminal native non-start is unproven','SESSION_RECOVERY_UNPROVEN');
      if (submission && ['runtime','sessionId','incarnationId','cwd','threadId','pid','executable'].some(key=>proof.receiver[key]!==submission.binding[key]))
        fail('proof belongs to another original receiver','SESSION_RECOVERY_UNPROVEN');
      await checkFile(goal.source); await checkFile(request.provenance); await loadManagedLaunch(intent.args); if (nextArgs) await loadManagedLaunch(nextArgs);
      if (previous) {receipt={...previous,duplicate:true};return goal;}
      receipt={event:'session-start-recovery',unit,id:request.id,seq:intent.seq,key:intent.key,request:structuredClone(request),userInputRef,requestDigest,
        intentDigest:binding.intentDigest,proof:structuredClone(proof),sessionHistoryLength:record.sessionHistory?.length ?? 0,nextArgs,nextKey:nextArgs?prepareEffect('session.start',nextArgs).key:null,
        ...(settleOnly?{settled:true,nextAttempt,goalId:goal.goal.id,targetUnit:record.targetUnit,source:structuredClone(goal.source)}:{})};
      await ledger.append(receipt);
      return goal;
    });
    if (review) await store.withLock(record.targetUnit,reserve); else await reserve(null);
    return receipt;
  }));
}
