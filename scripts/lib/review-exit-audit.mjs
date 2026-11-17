import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {taskPackets} from './session-task.mjs';
import {loadManagedLaunch} from './continuity-launch-io.mjs';
import {effectArgsDigest as digest} from './approvals.mjs';

export function originalReviewDeliveryArgs(record) {
  const {deliveryReceipt,ownerRetained,closeReceipt,...plan}=record.sessionFinalization;
  const epoch=record.deliveredRework?.length||record.completionRecoveries?.length
    ? digest({rework:record.deliveredRework?.at(-1)?.requestDigest??null,recovery:record.completionRecoveries?.at(-1)?.requestDigest??null}):undefined;
  return {...plan,...(epoch?{recoveryEpoch:epoch}:{}),cwd:plan.recipient.cwd,session:plan.recipient.sessionId,incarnation:plan.recipient.incarnationId};
}
const endpoint=owner=>({runtime:owner.runtime,sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd:owner.cwd,threadId:owner.worker?.threadId,pid:owner.worker?.pid,executable:owner.worker?.executable});

export function retiredReviewFinalization({reviewer,rows,goal}) {
  const index=rows.findLastIndex(row=>row.event==='review-finalization-recovery');
  if(index<0 || index!==rows.length-1)return false;
  const audit=rows[index],prefix=rows.slice(0,index),request=audit.request,proof=audit.proof;
  const intent=prefix.findLast(row=>row.event==='intent'&&row.key===audit.key&&row.seq===audit.seq);
  const plan=reviewer?.sessionFinalization;
  const start=prefix.find(row=>row.event==='intent'&&row.effect==='session.start');
  const submitted=prefix.findLast(row=>row.event==='submission'&&row.seq===start?.seq&&row.key===start?.key)?.binding;
  const receiver=submitted&&Object.fromEntries(['runtime','sessionId','incarnationId','cwd','threadId','pid','executable'].map(key=>[key,submitted[key]]));
  const previous=[...(goal?.adoptions??[]),...(goal?.rebindings??[]),...(goal?.handovers??[])].find(item=>digest(item)===audit.previousCustodyDigest);
  return reviewer?.kind==='review' && reviewer.state==='Closed' && plan?.mode==='review'
    && plan.owner && plan.recipient && !plan.closeReceipt && !plan.retainedOwner && !plan.sessionStart
    && audit.mode==='exited-review-finalization' && audit.unit===reviewer.unit && audit.targetUnit===reviewer.targetUnit
    && audit.goalId===reviewer.continuity?.goalId && audit.goalId===goal?.goal.id
    && audit.unitDigest===digest(reviewer) && audit.planDigest===digest(plan) && audit.ledgerDigest===digest(prefix)
    && audit.sourceDigest===digest(goal.source) && previous?.owner && previous.unit===reviewer.targetUnit
    && request?.owner && request.provenance && request.id===audit.id && request.unitDigest===audit.unitDigest && request.ledgerDigest===audit.ledgerDigest
    && audit.requestDigest===digest({request,userInputRef:audit.userInputRef})
    && intent?.effect==='session.deliver' && audit.effect===intent.effect && audit.intentDigest===digest(intent) && digest(intent.args)===digest(originalReviewDeliveryArgs(reviewer))
    && !prefix.some(row=>row.key===intent.key&&row.seq===intent.seq&&['result','submission'].includes(row.event))
    && proof?.verified===true && proof.receiverExited===true && proof.recipientExited===true && proof.ownerFenced===true && proof.recipientFenced===true
    && receiver && proof.receiver && proof.recipient && digest(proof.receiver)===digest(receiver) && digest(proof.recipient)===digest(endpoint(previous.owner))
    && /^sha256:[a-f0-9]{64}$/.test(audit.gitTargetDigest??'') && proof.gitTargetDigest===audit.gitTargetDigest
    && proof.unit===reviewer.unit && proof.targetUnit===reviewer.targetUnit && proof.goalId===goal.goal.id && proof.userInputRef===audit.userInputRef
    && proof.goalDigest===request.goalDigest && proof.targetDigest===request.targetDigest && proof.ownerDigest===digest(request.owner)
    && proof.previousCustodyDigest===request.previousCustodyDigest && proof.provenanceDigest===request.provenance.digest
    && !['taskNeverStarted','receiverSuspended','closed','deliveryCompleted'].some(key=>Object.hasOwn(proof,key))
    && proof.unitDigest===audit.unitDigest && proof.intentDigest===audit.intentDigest && proof.planDigest===audit.planDigest
    && proof.argsDigest===audit.requestDigest && proof.ledgerDigest===audit.ledgerDigest
    && proof.evidenceDigest===request.provenance?.digest;
}

export async function verifyRetiredReviewFinalization({stateRoot,reviewer,rows,goal}) {
  if(!retiredReviewFinalization({reviewer,rows,goal}))return false;
  try {
    await taskPackets(reviewer.sessionFinalization);
    const start=rows.find(row=>row.event==='intent'&&row.effect==='session.start');
    await loadManagedLaunch(start.args);
    const attempt=reviewer.stages.find(stage=>stage.name==='review').attempts.at(-1);
    const input=JSON.parse(await readFile(path.resolve(stateRoot,'units',reviewer.unit,attempt.inputPath),'utf8'));
    const {inputDigest,...envelope}=input;
    return inputDigest===attempt.inputDigest&&digest(envelope)===inputDigest;
  }catch{return false;}
}
