import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createLedgerStore,sessionEffectRetired} from './ledger.mjs';
import {transitionRecord} from './unit-state.mjs';
import {goalOwner} from './continuity-custody.mjs';
import {prepareEffect} from './policy.mjs';

const fail=(message,code='COMPLETION_RECOVERY_INVALID')=>{throw Object.assign(new Error(message),{code});};
const digest=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string' && value.trim().length>0;

// Retiring an uncertain close is allowed only after a trusted host has fenced the old executor.
export async function recoverGoalCompletion({stateRoot,store,unit,request,userInputRef,adapters}) {
  const fields=['id','expectedRevision','expectedGoalRevision','reservationDigest','targetDigest','provenance','reason'];
  if (!request || Object.keys(request).sort().join(',')!==fields.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
    || !digest(request.reservationDigest) || !digest(request.targetDigest)
    || Object.keys(request.provenance ?? {}).sort().join(',')!=='digest,path'
    || !path.isAbsolute(request.provenance.path ?? '') || !digest(request.provenance.digest)
    || !text(request.reason) || !text(userInputRef)) fail('exact revisions, reservation, target, provenance and user authorization are required');
  if (typeof adapters.git?.inspectUnit!=='function') fail('trusted Git inspection is required','ADAPTER_MISSING');
  const requestDigest=effectArgsDigest({request,userInputRef}), goals=createContinuityStore(stateRoot);
  const duplicate=new Error('completion recovery already recorded'); let receipt;
  try { await createLedgerStore(stateRoot).withLock(unit,async ledger=>{
    const rows=await ledger.read();
    await store.update(unit,async record=>{
      const previous=(record.completionRecoveries ?? []).find(item=>item.id===request.id);
      if (previous) {if(previous.requestDigest!==requestDigest) fail('recovery id binds another request','COMPLETION_RECOVERY_CONFLICT');receipt={...previous,duplicate:true};throw duplicate;}
      if (record.revision!==request.expectedRevision || !['Delivered','SelfGated'].includes(record.state) || !record.continuity?.goalId)
        fail('unit changed or is not awaiting completion recovery','CONTINUITY_STALE');
      const checkpoint=rows.findLast(row=>row.event==='goal-completion-recovery' && row.id===request.id);
      if (!checkpoint && typeof adapters.provider?.verifyGoalCompletionRecovery!=='function')
        fail('trusted completion recovery verifier is required','ADAPTER_MISSING');
      if (checkpoint && (checkpoint.requestDigest!==requestDigest || checkpoint.unitDigest!==effectArgsDigest(record)))
        fail('completion recovery checkpoint differs','CONTINUITY_STALE');
      const closeIntents=rows.filter(row=>row.event==='intent' && row.effect==='session.close'
        && (!sessionEffectRetired(rows,row) || checkpoint && row.seq===checkpoint.seq && row.key===checkpoint.key));
      if (closeIntents.length>1) fail('multiple close effects require reconciliation','EFFECT_UNCERTAIN');
      const intent=closeIntents[0] ?? null;
      if (intent && prepareEffect('session.close',intent.args).key!==intent.key) fail('close intent key does not match its arguments','EFFECT_UNCERTAIN');
      if (checkpoint && (checkpoint.intentDigest!==effectArgsDigest(intent)
        || (intent?.seq ?? null)!==checkpoint.seq || (intent?.key ?? null)!==checkpoint.key))
        fail('completion recovery effect checkpoint differs','CONTINUITY_STALE');
      const result=intent && rows.findLast(row=>row.event==='result' && row.key===intent.key && row.seq===intent.seq);
      if (record.sessionFinalization?.closeReceipt || result?.result?.closed===true || result?.result?.result?.closed===true
        || ['completed','reconciled'].includes(result?.result?.status))
        fail('owner close may have applied; reconcile its receipt instead','EFFECT_UNCERTAIN');
      if (rows.some(row=>{
        if (row.event!=='intent' || row===intent || sessionEffectRetired(rows,row)) return false;
        const latest=rows.findLast(done=>done.event==='result' && done.seq===row.seq && done.key===row.key);
        return !latest || ['unknown','uncertain'].includes(latest.result?.status);
      }))
        fail('another effect remains uncertain','EFFECT_UNCERTAIN');
      const target=await adapters.git.inspectUnit({unit,record});
      if (!target?.head || !target?.contentFingerprint) fail('Git target is unavailable','CONTINUITY_STALE');
      if (checkpoint ? effectArgsDigest(checkpoint.target ?? null)!==request.targetDigest : effectArgsDigest(target)!==request.targetDigest)
        fail('Git target changed before recovery was verified','CONTINUITY_STALE');
      const checkSource=async()=>{const bytes=await readFile(request.provenance.path);if (`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==request.provenance.digest) fail('provenance changed','CONTINUITY_STALE');};
      const current=await goals.read(record.continuity.goalId);
      const done=current?.completionRecoveries?.find(item=>item.id===request.id);
      if (done) {
        if (!checkpoint || done.requestDigest!==requestDigest || done.checkpointDigest!==effectArgsDigest(checkpoint))
          fail('completion recovery history differs','CONTINUITY_STALE');
        receipt=checkpoint;
      } else {
        const reservation=current?.completionReservation;
        if (!reservation || current.revision!==request.expectedGoalRevision || effectArgsDigest(reservation)!==request.reservationDigest
          || reservation.unit!==unit || current.goal.status!=='active' || current.goal.remaining[0]!==unit)
          fail('goal completion reservation changed','CONTINUITY_STALE');
        const {deliveryReceipt,ownerRetained,closeReceipt,...stablePlan}=record.sessionFinalization ?? {};
        if (effectArgsDigest(stablePlan)!==reservation.planDigest || effectArgsDigest(record.goalCompletion ?? null)!==reservation.completionDigest
          || effectArgsDigest(reservation.accepted)!==reservation.acceptedDigest
          || record.accepted && effectArgsDigest(record.accepted)!==reservation.acceptedDigest)
          fail('reserved finalization or accepted target changed','CONTINUITY_STALE');
        await goals.transaction(record.continuity.goalId,async goal=>{
          if (goal.revision!==request.expectedGoalRevision || effectArgsDigest(goal.completionReservation)!==request.reservationDigest)
            fail('goal completion reservation changed','CONTINUITY_STALE');
          if (checkpoint && (!checkpoint.proof || checkpoint.goalDigest!==effectArgsDigest(goal)))
            fail('completion recovery proof checkpoint differs','CONTINUITY_STALE');
          const owner=record.sessionFinalization?.owner ?? goalOwner(goal,unit);
          if (!owner || !['sessionId','incarnationId','cwd'].every(key=>text(owner[key])) || !path.isAbsolute(owner.cwd)
            || intent && (intent.args.session!==owner.sessionId || intent.args.incarnation!==owner.incarnationId))
            fail('reserved owner or close intent identity is incomplete','COMPLETION_RECOVERY_UNPROVEN');
          if (!checkpoint) await checkSource();
          const binding={unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:effectArgsDigest(record),
            goalDigest:effectArgsDigest(goal),reservationDigest:request.reservationDigest,targetDigest:request.targetDigest,
            intentDigest:effectArgsDigest(intent),resultDigest:effectArgsDigest(result ?? null),provenanceDigest:request.provenance.digest};
          if (!checkpoint) await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.completion.recover',reason:request.reason});
          const proof=checkpoint?.proof ?? await adapters.provider.verifyGoalCompletionRecovery({...binding,request:structuredClone(request),record:structuredClone(record),
            goal:structuredClone(goal),intent:structuredClone(intent),result:structuredClone(result ?? null),target:structuredClone(target)});
          if (proof?.verified!==true || Object.entries(binding).some(([key,value])=>proof[key]!==value)
            || proof.closeNotApplied!==true || proof.oldExecutionFenced!==true || proof.ownerAlive!==true || proof.queueSettled!==true
            || ['sessionId','incarnationId','cwd'].some(key=>proof.owner?.[key]!==owner[key])
            || proof.evidenceDigest!==request.provenance.digest) fail('close non-application or old execution fence is unproven','COMPLETION_RECOVERY_UNPROVEN');
          if (!checkpoint && effectArgsDigest(await adapters.git.inspectUnit({unit,record}))!==request.targetDigest) fail('Git target changed during recovery','CONTINUITY_STALE');
          if (!checkpoint) await checkSource();
          receipt=checkpoint ?? {event:'goal-completion-recovery',unit,id:request.id,seq:intent?.seq ?? null,key:intent?.key ?? null,
            intentDigest:effectArgsDigest(intent),request:structuredClone(request),requestDigest,userInputRef,unitDigest:binding.unitDigest,
            goalDigest:binding.goalDigest,target:structuredClone(target),proof:structuredClone(proof),at:adapters.now()};
          if (!checkpoint) await ledger.append(receipt);
          const {completionReservation,...rest}=goal;
          return {...rest,revision:goal.revision+1,completionRecoveries:[...(goal.completionRecoveries ?? []),
            {id:request.id,unit,requestDigest,checkpointDigest:effectArgsDigest(receipt),reservation,at:receipt.at}]};
        },{completionReservation:request.reservationDigest});
      }
      const recoveredReservation=current?.completionReservation ?? done?.reservation;
      const prior=recoveredReservation?.prior ? {...recoveredReservation.prior,sessionFinalization:record.sessionFinalization ?? recoveredReservation.prior.sessionFinalization}
        : {accepted:record.accepted ?? recoveredReservation?.accepted,deliveryResult:record.deliveryResult,deliveryPlan:record.deliveryPlan,
        sessionFinalization:record.sessionFinalization,goalCompletion:record.goalCompletion,evidence:record.evidence,
        reviewDecision:record.reviewDecision,reviewedHead:record.reviewedHead,verdict:record.verdict,result:record.result,resultRef:record.resultRef,next:record.next};
      const next={...record,accepted:null,deliveryResult:null,deliveryPlan:null,sessionFinalization:null,goalCompletion:null,
        evidence:(record.evidence ?? []).map(item=>({...item,status:'stale',covers:[]})),reviewDecision:null,reviewedHead:null,verdict:null,
        result:null,resultRef:null,next:null,completionRecoveries:[...(record.completionRecoveries ?? []),{...receipt,prior}]};
      return record.state==='SelfGated'?next:transitionRecord(next,'SelfGated');
    });
  }); } catch(error) {if(error!==duplicate) throw error;}
  return receipt;
}
