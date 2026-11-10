import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {acquireContinuityLock} from './continuity-lock.mjs';
import {createLedgerStore,sessionEffectRetired} from './ledger.mjs';
import {goalOwner} from './continuity-custody.mjs';
import {validateAcceptedContent} from './delivery.mjs';
import {evaluateAcceptance} from './evidence.mjs';
import {selectProfile} from './profile.mjs';
import {productAcceptance} from './acceptance-correction.mjs';

const fail=(message,code='GOAL_BIND_INVALID')=>{throw Object.assign(new Error(message),{code});};
const id=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['.','..'].includes(value);
const digest=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
async function sourceUnchanged(source){
  if(!path.isAbsolute(source?.path??'') || !digest(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}`!==source.digest)fail('goal source changed','GOAL_BIND_STALE');
}

// One atomic unit update; goal custody is held through the commit, without writing a goal or native receipt.
export async function recoverMissingGoalBinding({stateRoot,store,unit,request,userInputRef,adapters}){
  const keys=['recover','id','goalId','expectedRevision','expectedGoalRevision','unitDigest','goalDigest','targetDigest','reason'];
  if(!request || Object.keys(request).sort().join(',')!==keys.sort().join(',') || request.recover!==true
    || !id(request.id) || !id(request.goalId) || ![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
    || ![request.unitDigest,request.goalDigest,request.targetDigest].every(digest)
    || typeof request.reason!=='string' || !request.reason.trim() || typeof userInputRef!=='string' || !userInputRef.trim())fail('exact recovery request and original human input are required');
  if(typeof adapters.git?.inspectUnit!=='function')fail('live target inspection is required','ADAPTER_MISSING');
  const goals=createContinuityStore(stateRoot),requestDigest=effectArgsDigest({request,userInputRef}),duplicate=new Error('binding already recovered');
  let receipt,goalLock;
  try{
    await createLedgerStore(stateRoot).withLock(unit,async ledger=>{
      const rows=await ledger.read();
      await store.update(unit,async record=>{
        const previous=(record.goalBindings??[]).find(item=>item.id===request.id);
        if(previous){
          if(previous.requestDigest!==requestDigest || record.continuity?.goalId!==previous.goalId)fail('binding id or goal changed','GOAL_BIND_CONFLICT');
          receipt={...previous,duplicate:true};throw duplicate;
        }
        if(record.revision!==request.expectedRevision || effectArgsDigest(record)!==request.unitDigest)fail('unit changed','GOAL_BIND_STALE');
        if(record.state!=='Accepted' || ['review','ops'].includes(record.kind) || !record.continuityRequired || record.continuity?.goalId
          || typeof record.request?.text!=='string' || typeof record.request?.userInputRef!=='string'
          || record.request?.overallGoal || record.deliveryPlan || record.deliveryResult || record.sessionFinalization || record.sessionHistory?.length
          || (record.stages??[]).some(stage=>(stage.attempts??[]).some(attempt=>!attempt.endedAt)))fail('an unbound, submitted, undelivered Accepted change unit is required');
        if(rows.some(row=>row.event==='intent' && (row.effect?.startsWith('session.') || !sessionEffectRetired(rows,row)
          && !rows.some(done=>done.event==='result' && done.seq===row.seq && done.key===row.key && !['unknown','uncertain'].includes(done.result?.status)))))
          fail('existing native activity or uncertain effects require investigation','EFFECT_UNCERTAIN');
        const target=await adapters.git.inspectUnit({unit,record});
        if(effectArgsDigest(target??null)!==request.targetDigest || !validateAcceptedContent(record.accepted,target).valid)fail('accepted target changed','GOAL_BIND_STALE');
        const review=record.reviewedHead?{verdict:record.verdict,head:record.reviewedHead,contentFingerprint:record.reviewDecision?.contentFingerprint}:null;
        const evaluation=evaluateAcceptance({acceptance:productAcceptance(record),evidence:record.evidence??[],requiredGates:selectProfile(record.kind).gates,
          head:record.head,contentFingerprint:record.contentFingerprint,currentHead:target.head,currentContentFingerprint:target.contentFingerprint,
          reviewRequired:record.reviewDecision?.required===true || record.policy?.review?.mode==='required',review,findings:record.findings??[],enforceSnapshot:true});
        if(!evaluation.ok)fail('existing acceptance or independent review is not valid','GOAL_BIND_UNPROVEN');
        if(!await goals.read(request.goalId))fail('goal not found','GOAL_NOT_FOUND');
        goalLock=await acquireContinuityLock(path.join(path.resolve(stateRoot),'goals',request.goalId,'.lock'));
        const goal=await goals.read(request.goalId);
        if(!goal || goal.revision!==request.expectedGoalRevision || effectArgsDigest(goal)!==request.goalDigest
          || goal.goal.status!=='active' || goal.goal.remaining[0]!==unit)fail('goal changed or is not the current target','GOAL_BIND_STALE');
        if(goalOwner(goal,unit) || (goal.reviews??[]).some(item=>item.unit===unit || item.targetUnit===unit))fail('goal already has custody for this unit','GOAL_BIND_CONFLICT');
        await sourceUnchanged(goal.source);
        const binding={unit,goalId:request.goalId,userInputRef,effect:'unit.goal.bind.recover',argsDigest:requestDigest,
          unitDigest:request.unitDigest,goalDigest:request.goalDigest,targetDigest:request.targetDigest,sourceDigest:goal.source.digest,
          originalRequestDigest:effectArgsDigest(record.request),policyDigest:effectArgsDigest(goal.policy),reason:request.reason};
        await verifyApprovalInput(adapters.provider,binding);
        await sourceUnchanged(goal.source);
        if(effectArgsDigest(await adapters.git.inspectUnit({unit,record}))!==request.targetDigest)fail('target changed during verification','GOAL_BIND_STALE');
        goalLock.assertHeld();
        receipt={id:request.id,goalId:request.goalId,request:structuredClone(request),userInputRef,requestDigest,
          previous:{request:structuredClone(record.request),policy:structuredClone(record.policy)},policyDigest:binding.policyDigest,
          source:structuredClone(goal.source),revision:record.revision+1,boundAt:adapters.now()};
        return {...record,continuity:{goalId:request.goalId},request:{...record.request,overallGoal:{id:goal.goal.id,objective:goal.goal.objective,criteria:goal.goal.criteria,source:goal.source}},
          goalBindings:[...(record.goalBindings??[]),receipt]};
      });
    });
  }catch(error){if(error!==duplicate)throw error;}finally{await goalLock?.close();}
  return receipt;
}
