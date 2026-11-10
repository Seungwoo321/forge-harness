import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createLedgerStore,sessionEffectRetired} from './ledger.mjs';
import {transitionRecord} from './unit-state.mjs';
import {currentCorrections,verifyAcceptanceCorrections} from './acceptance-correction.mjs';
import {prepareEffect} from './policy.mjs';

const fail=(message,code='DELIVERED_REWORK_INVALID')=>{throw Object.assign(new Error(message),{code});};
const digest=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string' && value.trim();

// A trusted host proves the old finalizer and its native queue are fenced before any history is retired.
export async function reopenDelivered({stateRoot,store,unit,request,userInputRef,adapters}) {
  const fields=['id','expectedRevision','expectedGoalRevision','intent','provenance','acceptance','reason'];
  if (!request || Object.keys(request).sort().join(',')!==fields.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(x=>Number.isSafeInteger(x) && x>0)
    || Object.keys(request.intent ?? {}).sort().join(',')!=='argsDigest,key,seq'
    || !digest(request.intent.key) || !digest(request.intent.argsDigest) || !Number.isSafeInteger(request.intent.seq) || request.intent.seq<1
    || Object.keys(request.provenance ?? {}).sort().join(',')!=='digest,path'
    || !path.isAbsolute(request.provenance.path ?? '') || !digest(request.provenance.digest)
    || !Array.isArray(request.acceptance) || !request.acceptance.length
    || request.acceptance.some(a=>!a || Object.keys(a).sort().join(',')!=='id,text' || !text(a.id) || !text(a.text))
    || new Set(request.acceptance.map(a=>a.id)).size!==request.acceptance.length || !text(request.reason) || !text(userInputRef))
    fail('exact revisions, delivery intent, acceptance, provenance and user authorization are required');
  if (typeof adapters.git?.inspectUnit!=='function') fail('trusted Git inspection is required','ADAPTER_MISSING');
  const requestDigest=effectArgsDigest({request,userInputRef}), goals=createContinuityStore(stateRoot);
  let receipt, goalId;
  const duplicate = new Error('rework already recorded');
  try { await createLedgerStore(stateRoot).withLock(unit,async ledger=>{
    const rows=await ledger.read();
    try { await store.update(unit,async record=>{
      goalId=record.continuity?.goalId;
      const prior=(record.deliveredRework ?? []).find(item=>item.id===request.id);
      if (prior) { if (prior.requestDigest!==requestDigest) fail('rework id binds another request'); receipt={...prior,duplicate:true}; throw duplicate; }
      if (record.revision!==request.expectedRevision || record.state!=='Delivered' || !record.accepted || !record.deliveryResult
        || !record.sessionFinalization || !record.continuity?.goalId || record.kind==='review')
        fail('current delivered unit, accepted target and pending finalization are required','CONTINUITY_STALE');
      if (record.sessionFinalization.closeReceipt || rows.some(row=>row.event==='intent' && row.effect==='session.close'))
        fail('owner close may have started; reconcile it before rework','EFFECT_UNCERTAIN');
      if (!record.acceptance?.every(old=>request.acceptance.some(next=>next.id===old.id && next.text===old.text))) fail('existing criteria cannot be removed or changed');
      const marker=rows.findLast(row=>row.event==='delivered-rework' && row.id===request.id);
      if (marker && (marker.requestDigest!==requestDigest || marker.recordDigest!==effectArgsDigest(record)))
        fail('rework checkpoint differs from the current request or unit','CONTINUITY_STALE');
      const intent=rows.findLast(row=>row.event==='intent' && row.effect==='session.deliver');
      if (!intent || intent.seq!==request.intent.seq || intent.key!==request.intent.key || effectArgsDigest(intent.args)!==request.intent.argsDigest
        || prepareEffect('session.deliver',intent.args).key!==intent.key
        || sessionEffectRetired(rows,intent) && !marker || rows.some(row=>row.event==='result' && row.key===intent.key && row.seq===intent.seq))
        fail('only the exact unresolved result delivery may be superseded','EFFECT_UNCERTAIN');
      if (rows.some(row=>{
        if (row.event!=='intent' || row===intent || sessionEffectRetired(rows,row)) return false;
        const latest=rows.findLast(done=>done.event==='result' && done.seq===row.seq && done.key===row.key);
        return !latest || ['unknown','uncertain'].includes(latest.result?.status);
      }))
        fail('another effect remains uncertain','EFFECT_UNCERTAIN');
      const target=await adapters.git.inspectUnit({unit,record});
      if (!target?.head || !target?.contentFingerprint) fail('Git target is unavailable','CONTINUITY_STALE');
      const targetDigest=effectArgsDigest(target), recordDigest=effectArgsDigest(record);
      const reserved=await goals.transaction(record.continuity.goalId,async goal=>{
        const pending=goal?.reworkReservation;
        if (pending) {
          const obligations=[...(record.inheritedDeliveryObligations ?? []), ...currentCorrections(record)
            .map(({request:correction})=>correction).filter(correction=>correction.kind==='delivery')];
          if (pending.requestDigest!==requestDigest || pending.unitDigest!==recordDigest
            || pending.checkpoint.intentDigest!==effectArgsDigest(intent)
            || effectArgsDigest(pending.inheritedDeliveryObligations)!==effectArgsDigest(obligations)
            || marker && effectArgsDigest(marker)!==effectArgsDigest(pending.checkpoint))
            fail('existing rework reservation differs','CONTINUITY_STALE');
          return goal;
        }
        if (marker || !goal || goal.revision!==request.expectedGoalRevision || goal.goal.status!=='active' || goal.goal.remaining[0]!==unit)
          fail('goal changed or is not active','CONTINUITY_STALE');
        if (typeof adapters.provider?.verifyDeliveredRework!=='function') fail('trusted finalization verifier is required','ADAPTER_MISSING');
        if (target.head!==record.accepted.head || target.contentFingerprint!==record.accepted.contentFingerprint)
          fail('accepted target changed','CONTINUITY_STALE');
        await verifyAcceptanceCorrections(record,adapters,target);
        const inheritedDeliveryObligations=[...(record.inheritedDeliveryObligations ?? []), ...currentCorrections(record)
          .map(({request:correction})=>correction).filter(correction=>correction.kind==='delivery')];
        const bytes=await readFile(request.provenance.path);
        if (`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==request.provenance.digest) fail('provenance changed','CONTINUITY_STALE');
        const binding={unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:recordDigest,
          goalDigest:effectArgsDigest(goal),intentDigest:effectArgsDigest(intent),targetDigest,provenanceDigest:request.provenance.digest};
        const owner=record.sessionFinalization.owner;
        if (!owner || !['sessionId','incarnationId','cwd'].every(key=>text(owner[key])) || !path.isAbsolute(owner.cwd)) fail('original owner identity is incomplete','DELIVERED_REWORK_UNPROVEN');
        await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.delivered.rework',reason:request.reason});
        const proof=await adapters.provider.verifyDeliveredRework({...binding,request:structuredClone(request),intent:structuredClone(intent),
          record:structuredClone(record),goal:structuredClone(goal),target:structuredClone(target)});
        if (proof?.verified!==true || Object.entries(binding).some(([k,v])=>proof[k]!==v)
          || proof.finalizerStopped!==true || proof.oldExecutionFenced!==true || proof.queueSettled!==true
          || proof.ownerAlive!==true || proof.deliveryVerified!==true || ['sessionId','incarnationId','cwd'].some(key=>proof.owner?.[key]!==owner[key])
          || proof.evidenceDigest!==request.provenance.digest)
          fail('finalization, native queue or delivery is not conclusively fenced','DELIVERED_REWORK_UNPROVEN');
        if (effectArgsDigest(await adapters.git.inspectUnit({unit,record}))!==targetDigest)
          fail('target changed during verification','CONTINUITY_STALE');
        const checkpoint={event:'delivered-rework',id:request.id,unit,seq:intent.seq,key:intent.key,intentDigest:effectArgsDigest(intent),
          request:structuredClone(request),requestDigest,userInputRef,targetDigest,recordDigest,goalDigest:binding.goalDigest,
          proof:structuredClone(proof),revision:record.revision+1,at:adapters.now()};
        return {...goal,revision:goal.revision+1,reworkReservation:{unit,requestDigest,unitDigest:recordDigest,inheritedDeliveryObligations,checkpoint}};
      },{reworkReservation:requestDigest});
      receipt=reserved.reworkReservation.checkpoint;
      const inheritedDeliveryObligations=reserved.reworkReservation.inheritedDeliveryObligations;
      if (!marker) await ledger.append(receipt);
      const previous={accepted:record.accepted,deliveryResult:record.deliveryResult,deliveryPlan:record.deliveryPlan,
        sessionFinalization:record.sessionFinalization,goalCompletion:record.goalCompletion,acceptance:record.acceptance,
        acceptanceCorrections:record.acceptanceCorrections,evidence:record.evidence,reviewDecision:record.reviewDecision,
        reviewedHead:record.reviewedHead,verdict:record.verdict,result:record.result,resultRef:record.resultRef,next:record.next};
      return transitionRecord({...record,accepted:null,deliveryResult:null,deliveryPlan:null,sessionFinalization:null,goalCompletion:null,
        inheritedDeliveryObligations,
        acceptance:request.acceptance.map(item=>structuredClone(record.acceptance.find(old=>old.id===item.id) ?? item)),acceptanceCorrections:[],evidence:(record.evidence ?? []).map(item=>({...item,status:'stale',covers:[]})),
        reviewDecision:null,reviewedHead:null,verdict:null,result:null,resultRef:null,next:null,
        deliveredRework:[...(record.deliveredRework ?? []),{...receipt,previous}],
        reopenings:[...(record.reopenings ?? []),{revision:record.revision+1,from:'Delivered',reason:request.reason,evidence:request.provenance.path,at:receipt.at}]},'Implementing');
    }); } catch (error) { if (error!==duplicate) throw error; }
    const goal=goalId ? await goals.read(goalId) : null;
    if (goal?.reworkReservation?.requestDigest===requestDigest) await goals.transaction(goalId,current=>{
      if (current?.reworkReservation?.requestDigest!==requestDigest) fail('rework reservation changed','CONTINUITY_STALE');
      const {reworkReservation,...rest}=current; return {...rest,revision:current.revision+1};
    },{reworkReservation:requestDigest});
  }); } catch (error) { if (error!==duplicate) throw error; }
  return receipt;
}
