import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest as digest, verifyApprovalInput } from './approvals.mjs';
import { createLedgerStore, unresolvedEffect } from './ledger.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { goalOwner, nativeOwner, assertReviewsSettled } from './continuity-custody.mjs';
import { withSuspendedReviewLocks, verifySuspendedReviews } from './suspended-review.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';
import { loadManagedLaunch } from './continuity-launch-io.mjs';

const fail = (message,code='CUSTODY_INVALID') => {throw Object.assign(new Error(message),{code});};
const sha = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const text = value => typeof value === 'string' && value.trim();
async function sourceMatches(source) {
  if (!path.isAbsolute(source?.path ?? '') || !sha(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest)
    fail('canonical source changed','CUSTODY_STALE');
}

// A managed bootstrap records no native owner. Prove the claimed old identity from its own original start evidence.
async function managedOwner({previous,claimed,rows,unit}) {
  const old=nativeOwner(claimed);
  if(digest(old)!==digest(claimed) || ['sessionId','incarnationId','cwd'].some(key=>old[key]!==previous[key]))fail('exact managed owner identity required');
  const intent=rows.find(row=>row.event==='intent' && row.effect==='session.start' && row.key===previous.effectKey);
  const result=rows.findLast(row=>row.event==='result' && row.key===intent?.key && row.seq===intent?.seq)?.result;
  if(!intent || intent.args?.unit!==unit || intent.args.role!=='implementation' || intent.args.attempt!==(previous.attempt??1)
    || intent.args.goalPath!==previous.goalPath || intent.args.goalDigest!==previous.goalDigest
    || ['sessionId','incarnationId','cwd'].some(key=>result?.[key]!==old[key]) || result.task?.threadId!==old.worker.threadId)
    fail('managed owner differs from its original start receipt','CUSTODY_CONFLICT');
  for(const row of rows.filter(item=>['submission','receiver','confirmation'].includes(item.event) && item.key===intent.key && item.seq===intent.seq)){
    if(['runtime','sessionId','incarnationId','cwd'].some(key=>row.binding?.[key]!==old[key])
      || ['pid','threadId','executable'].some(key=>row.binding?.[key]!==undefined && row.binding[key]!==old.worker[key]))
      fail('managed owner differs from its original native submission','CUSTODY_CONFLICT');
  }
  await loadManagedLaunch(intent.args);
  const execution=selectExecutionPolicy(JSON.parse(await readFile(intent.args.goalPath,'utf8')).policy,'implementation');
  if(execution.runtime!==old.runtime || execution.provider!==path.basename(old.worker.executable))fail('managed owner differs from its launch policy','CUSTODY_CONFLICT');
  return old;
}

// Handoff is a separate transition: adoption/restart never take over a live native owner.
export async function handoffGoalSession({stateRoot,store,unit,request,userInputRef,adapters,cwd,exited=false}) {
  const mode=exited?'exited-owner':'suspended-owner',effect=exited?'unit.session.reassign':'unit.session.handoff';
  const verifier=exited?'verifyExitedOwnerHandoff':'verifySessionHandoff';
  const keys = ['id','expectedRevision','expectedGoalRevision','unitDigest','goalDigest','targetDigest','previousCustodyDigest','owner','policy','provenance','reason',...(Object.hasOwn(request??{},'suspendedReviews')?['suspendedReviews']:[]),...(Object.hasOwn(request??{},'exitedReviews')?['exitedReviews']:[]),...(Object.hasOwn(request??{},'previousOwner')?['previousOwner']:[])];
  if (!request || Object.keys(request).sort().join(',') !== keys.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(value=>Number.isSafeInteger(value) && value>0)
    || ![request.unitDigest,request.goalDigest,request.targetDigest,request.previousCustodyDigest,request.provenance?.digest].every(sha)
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,ref' || !text(request.provenance.ref)
    || !text(request.reason) || !text(userInputRef)) fail('exact handoff request and sourced authority required');
  const owner=nativeOwner(request.owner);
  if (owner.runtime !== 'cmux' || digest(owner)!==digest(request.owner) || await realpath(cwd)!==owner.cwd) fail('exact cmux replacement owner cwd required');
  const execution=selectExecutionPolicy(request.policy,'implementation');
  for(const role of ['review','diagnosis','resolver'])selectExecutionPolicy(request.policy,role);
  if(execution.runtime!==owner.runtime || path.basename(owner.worker.executable)!==execution.provider)fail('replacement policy and native provider differ');
  if(typeof adapters.git?.inspectUnit!=='function' || typeof adapters.session?.observe!=='function'
    || typeof adapters.provider?.[verifier]!=='function')fail('trusted handoff verifiers required','ADAPTER_MISSING');
  const goals=createContinuityStore(stateRoot), requestDigest=digest({request,userInputRef});
  return createLedgerStore(stateRoot).withLock(unit,async ledger=>store.withLock(unit,async record=>{
    if(!record.continuity?.goalId || ['review','ops'].includes(record.kind)
      || !['Scoped','Implementing','SelfGated','InReview','Accepted'].includes(record.state)
      || record.sessionFinalization || record.deliveryPlan || record.deliveryResult)fail('active undelivered change unit required');
    const rows=await ledger.read();
    if(unresolvedEffect(rows))
      fail('reconcile uncertain effects before handoff','EFFECT_UNCERTAIN');
    let receipt;
    await withSuspendedReviewLocks({stateRoot,store,entries:request.suspendedReviews??[],exitedEntries:request.exitedReviews??[]},async lockedReviews=>goals.transaction(record.continuity.goalId,async goal=>{
      const prior=goal?.handovers?.find(item=>item.id===request.id);
      if(prior && ((prior.mode??'suspended-owner')!==mode || prior.requestDigest!==requestDigest))fail('handoff id binds another request','CUSTODY_CONFLICT');
      const current=goalOwner(goal,unit);
      const previous=prior ? [...(goal.adoptions??[]),...(goal.rebindings??[]),...(goal.handovers??[]),...(goal.bootstraps??[])].find(item=>digest(item)===request.previousCustodyDigest) : current;
      // A managed predecessor is the unit's own bootstrap; the request then names its exact native owner.
      const managed=Boolean(previous) && previous.ownership!=='existing';
      if(!goal || goal.goal.status!=='active' || goal.goal.remaining[0]!==unit || (managed ? !goal.bootstraps?.includes(previous) : previous?.ownership!=='existing')
        || managed!==Object.hasOwn(request,'previousOwner')
        || previous.unit!==unit || digest(previous)!==request.previousCustodyDigest
        || prior && digest(current)!==digest(prior))fail('current custody changed','CUSTODY_CONFLICT');
      const old=managed?await managedOwner({previous,claimed:request.previousOwner,rows,unit}):nativeOwner(previous.owner);
      if(old.runtime!==owner.runtime || old.cwd!==owner.cwd || old.sessionId===owner.sessionId
        || old.worker.threadId===owner.worker.threadId || old.worker.pid===owner.worker.pid)fail('distinct replacement native owner required');
      const before=prior ? {...goal,revision:request.expectedGoalRevision,policy:prior.previousPolicy} : goal;
      if(prior){if(prior.hadHandovers)before.handovers=goal.handovers.slice(0,-1);else delete before.handovers;}
      if(record.revision!==request.expectedRevision || digest(record)!==request.unitDigest || digest(before)!==request.goalDigest
        || goal.revision!==request.expectedGoalRevision+(prior?1:0)
        // A managed launch keeps its snapshot policy; its successor takes the current (refreshed) goal policy unchanged.
        || (managed ? digest(request.policy)!==digest(before.policy) : previous.policyDigest!==digest(before.policy))
        || prior && digest(goal.policy)!==digest(request.policy))fail('handoff snapshot changed','CUSTODY_STALE');
      let suspendedReviews=[],exitedReviews=[];
      const check=async()=>{
        await sourceMatches(goal.source);
        for(const source of record.canon??[])await sourceMatches({...source,path:path.resolve(cwd,source.path)});
        await sourceMatches({path:request.provenance.ref,digest:request.provenance.digest});
        if(digest(await adapters.git.inspectUnit({unit,record}))!==request.targetDigest)fail('handoff target changed','CUSTODY_STALE');
        const observed=await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd,[exited?'exitedOwner':'suspendedOwner']:structuredClone(old)});
        if(observed[exited?'previousOwnerExited':'previousOwnerSuspended']!==true || digest(nativeOwner(observed))!==digest(owner))fail('native replacement or suspension unverified','CUSTODY_UNPROVEN');
        const reviews=await verifySuspendedReviews({lockedReviews,goal:before,target:record,owner,adapters,managedTarget:managed});
        suspendedReviews=reviews.filter(item=>item.ownerState!=='exited');exitedReviews=reviews.filter(item=>item.ownerState==='exited');
        await assertReviewsSettled({stateRoot,store,goal,unit,suspendedReviews:[...suspendedReviews,...exitedReviews]});
      };
      const target=await adapters.git.inspectUnit({unit,record});
      if(digest(target)!==request.targetDigest || record.head && (record.head!==target.head || record.contentFingerprint!==target.contentFingerprint))fail('submitted target changed','CUSTODY_STALE');
      await check();
      const binding={unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:request.unitDigest,goalDigest:request.goalDigest,
        targetDigest:request.targetDigest,previousCustodyDigest:request.previousCustodyDigest,ownerDigest:digest(owner),policyDigest:digest(request.policy),previousPolicyDigest:digest(before.policy),ledgerDigest:digest(rows),suspendedReviewsDigest:digest(suspendedReviews),...(exited?{previousOwnerState:'exited'}:{}),...(request.exitedReviews?{exitedReviewsDigest:digest(exitedReviews)}:{}),...(managed?{previousOwnership:'managed',previousOwnerDigest:digest(old)}:{})};
      await verifyApprovalInput(adapters.provider,{...binding,effect,reason:request.reason});
      const verified=await adapters.provider[verifier]({...binding,request:structuredClone(request),record:structuredClone(record),goal:structuredClone(before),target:structuredClone(target),previousCustody:structuredClone(previous),suspendedReviews:structuredClone(suspendedReviews),...(request.exitedReviews?{exitedReviews:structuredClone(exitedReviews)}:{})});
      if(verified?.verified!==true || Object.entries(binding).some(([key,value])=>verified[key]!==value))fail('source-backed handoff permission unverified','CUSTODY_UNPROVEN');
      await check();
      if(prior){receipt={...prior,duplicate:true};return goal;}
      receipt={id:request.id,unit,mode,ownership:'existing',...owner,owner,request:structuredClone(request),userInputRef,requestDigest,
        previousCustodyDigest:request.previousCustodyDigest,previousPolicy:structuredClone(goal.policy),policyDigest:binding.policyDigest,
        suspendedReviews,...(request.exitedReviews?{exitedReviews}:{}),...(managed?{previousOwnership:'managed',previousOwner:old}:{}),goalRevision:goal.revision+1,hadHandovers:Object.hasOwn(goal,'handovers')};
      return {...goal,revision:goal.revision+1,policy:structuredClone(request.policy),handovers:[...(goal.handovers??[]),receipt]};
    }));
    return receipt;
  }));
}

export const reassignGoalSession=input=>handoffGoalSession({...input,exited:true});
