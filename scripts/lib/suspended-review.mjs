import { readFile } from 'node:fs/promises';
import { selectExecutionPolicy } from './continuity-decision.mjs';
import path from 'node:path';
import { effectArgsDigest as digest } from './approvals.mjs';
import { nativeOwner } from './continuity-custody.mjs';
import { createLedgerStore } from './ledger.mjs';
import { prepareEffect } from './policy.mjs';
import { loadManagedLaunch } from './continuity-launch-io.mjs';

const fail = message => { throw Object.assign(new Error(message), {code:'CUSTODY_CONFLICT'}); };
const id = value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value ?? '') && !['.','..'].includes(value);
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');

// Startup locks a reviewer before its target. Nonblocking ledger acquisition avoids the reverse-order wait.
export async function withSuspendedReviewLocks({stateRoot,store,entries,exitedEntries=[]}, action) {
  if(!Array.isArray(entries)||!Array.isArray(exitedEntries))fail('exact reviewer inventories required');
  const listed=[...entries.map(entry=>({entry,exited:false})),...exitedEntries.map(entry=>({entry,exited:true}))];
  if(new Set(listed.map(({entry})=>entry?.unit)).size!==listed.length
    || listed.some(({entry})=>!entry || Object.keys(entry).sort().join(',')!=='ledgerDigest,owner,unit,unitDigest'
      || !id(entry.unit) || !sha(entry.unitDigest) || !sha(entry.ledgerDigest)))fail('exact disjoint reviewer inventory required');
  const sorted=listed.sort((a,b)=>a.entry.unit.localeCompare(b.entry.unit));
  const lock=async(index,locked)=> index===sorted.length ? action(locked)
    : createLedgerStore(stateRoot).withLock(sorted[index].entry.unit,async ledger=>store.withLock(sorted[index].entry.unit,async record=>{
      const rows=await ledger.read(),{entry,exited}=sorted[index];
      if(digest(record)!==entry.unitDigest || digest(rows)!==entry.ledgerDigest)fail('reviewer snapshot changed');
      return lock(index+1,[...locked,{entry,record,rows,exited}]);
    }),{wait:false});
  return lock(0,[]);
}

// A worked reviewer normally opens its StageInput first. Only that single unsubmitted attempt, still bound to
// the current target, may move: the recovered reviewer submits the same opened input.
async function onlyOpenedReview(stateRoot,record,target){
  const stages=record.stages??[];
  if(!stages.length)return true;
  const [stage]=stages,[attempt]=stage.attempts??[];
  if(stages.length!==1 || stage.name!=='review' || stage.attempts.length!==1 || attempt.endedAt!==null
    || ['result','outputDigest','submissionId'].some(key=>attempt[key]!==undefined) || typeof attempt.inputPath!=='string')return false;
  let input;
  try{input=JSON.parse(await readFile(path.join(stateRoot,'units',record.unit,attempt.inputPath),'utf8'));}catch{return false;}
  return input?.inputDigest===attempt.inputDigest && input.attempt===attempt.n && input.targetUnit===target.unit
    && Boolean(target.head) && input.head===target.head && input.contentFingerprint===target.contentFingerprint;
}

// A reviewer started by a managed target owner never bound the target digest; its audit pins the current target instead.
export async function verifySuspendedReviews({stateRoot,lockedReviews,goal,target,owner,adapters,managedTarget=false}) {
  const audited=[];
  for(const {entry,record,rows,exited} of lockedReviews){
    if(record.kind!=='review' || record.state!=='InReview' || record.targetUnit!==target.unit
      || record.continuity?.goalId!==goal.goal.id || record.sessionFinalization || record.deliveryPlan
      || record.verdict || !await onlyOpenedReview(stateRoot,record,target) || (goal.reviews??[]).some(item=>item.unit===record.unit))
      fail('only unregistered reviewers without a submitted stage can be suspended');
    const intent=rows.findLast(row=>row.event==='intent' && row.effect==='session.start');
    const submission=rows.findLast(row=>row.event==='submission' && row.key===intent?.key && row.seq===intent?.seq);
    const receiver=submission?.binding;
    const receivers=rows.filter(row=>['receiver','confirmation'].includes(row.event) && row.key===intent?.key && row.seq===intent?.seq);
    const old=nativeOwner(entry.owner);
    if(digest(old)!==digest(entry.owner) || old.cwd!==owner.cwd || old.sessionId===owner.sessionId
      || old.worker.pid===owner.worker.pid || old.worker.threadId===owner.worker.threadId
      || !intent || !submission || intent.args?.unit!==record.unit || intent.args.role!=='review'
      || intent.args.targetDigest!==(managedTarget?undefined:digest(target)) || prepareEffect('session.start',intent.args).key!==intent.key
      || rows.some(row=>row.event==='intent' && row!==intent)
      || rows.some(row=>['result','session-start-recovery'].includes(row.event))
      || ['runtime','sessionId','incarnationId','cwd'].some(key=>old[key]!==receiver[key])
      || ['pid','threadId','executable'].some(key=>old.worker[key]!==receiver[key]))
      fail('original reviewer startup or exact native identity changed');
    for(const row of receivers){
      if(['runtime','sessionId','incarnationId','cwd'].some(key=>row.binding?.[key]!==old[key])
        || ['pid','threadId','executable'].some(key=>(row.event==='confirmation' || row.binding?.[key]!==undefined) && row.binding?.[key]!==old.worker[key]))
        fail('original reviewer receiver or confirmation changed');
    }
    await loadManagedLaunch(intent.args);
    const original=JSON.parse(await readFile(intent.args.goalPath,'utf8'));
    if(original.goal.id!==goal.goal.id || digest(original.source)!==digest(goal.source)
      || selectExecutionPolicy(original.policy,'review').provider!==path.basename(old.worker.executable))
      fail('suspended reviewer belongs to another goal or execution policy');
    const observed=await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd,[exited?'exitedOwner':'suspendedOwner']:old});
    if(observed[exited?'previousOwnerExited':'previousOwnerSuspended']!==true || digest(nativeOwner(observed))!==digest(owner))fail('reviewer suspension or replacement changed');
    audited.push({unit:record.unit,unitDigest:entry.unitDigest,ledgerDigest:entry.ledgerDigest,owner:old,
      seq:intent.seq,key:intent.key,intentDigest:digest(intent),submissionDigest:digest(submission),
      targetDigest:digest(target),sourceDigest:digest(goal.source),...(exited?{ownerState:'exited'}:{})});
  }
  return audited;
}

export function suspendedReviewHandoff(goal,record,intent,submission,rows){
  const handover=(goal.handovers??[]).findLast(item=>item.unit===record.targetUnit
    && [...(item.suspendedReviews??[]),...(item.exitedReviews??[])].some(review=>review.unit===record.unit));
  const suspension=handover && [...(handover.suspendedReviews??[]),...(handover.exitedReviews??[])].find(item=>item.unit===record.unit);
  if(!suspension)return null;
  if(suspension.unitDigest!==digest(record) || suspension.ledgerDigest!==digest(rows)
    || suspension.key!==intent.key || suspension.seq!==intent.seq || suspension.intentDigest!==digest(intent)
    || suspension.submissionDigest!==digest(submission) || suspension.sourceDigest!==digest(goal.source))
    fail('suspended reviewer handoff audit changed');
  return {handover,suspension};
}
