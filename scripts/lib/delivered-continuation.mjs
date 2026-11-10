import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createLegacyFencedLedgerStore} from './legacy-fence.mjs';
import {createLedgerStore,sessionEffectRetired} from './ledger.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {goalOwner,nativeOwner} from './continuity-custody.mjs';
import {selectExecutionPolicy} from './continuity-decision.mjs';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const fail=(message,code='CONTINUITY_INVALID')=>{throw Object.assign(new Error(message),{code});};
const sha=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const unresolved=rows=>rows.some(row=>row.event==='intent'&&!sessionEffectRetired(rows,row)&&!rows.some(result=>result.event==='result'&&result.seq===row.seq&&result.key===row.key&&!['unknown','uncertain'].includes(result.result?.status)));

// Retain the Delivered unit verbatim and move only the goal cursor and successor custody.
export async function continueDeliveredGoal({stateRoot,store,unit,request,userInputRef,adapters}) {
  const keys=['id','goalId','successor','unitDigest','successorDigest','goalDigest','targetDigest','fenceDigest','owner','reason'];
  if (!request || Object.keys(request).sort().join(',')!==keys.sort().join(',')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id??'') || ['.','..'].includes(request.id)
    || !request.goalId || !request.successor || request.successor===unit || !userInputRef || !request.reason
    || ![request.unitDigest,request.successorDigest,request.goalDigest,request.targetDigest,request.fenceDigest].every(sha)) fail('exact continuation request is required');
  const owner=nativeOwner(request.owner);
  const goals=createContinuityStore(stateRoot),requestDigest=effectArgsDigest({unit,request,userInputRef});
  const snapshot=await goals.read(request.goalId),previous=snapshot?.transfers?.find(item=>item.unit===unit);
  if(previous){
    const adoption=snapshot.adoptions?.find(item=>item.unit===request.successor&&item.id===request.id);
    if(previous.deliveredContinuation===true&&previous.requestDigest===requestDigest&&previous.successor===request.successor
      &&adoption?.requestDigest===requestDigest&&effectArgsDigest(adoption.owner)===effectArgsDigest(owner)) return snapshot;
    fail('continuation conflicts with recorded transfer','CONTINUITY_STALE');
  }
  if(effectArgsDigest(owner)!==effectArgsDigest(request.owner) || typeof adapters.session?.observe!=='function'
    || typeof adapters.git?.inspectUnit!=='function' || typeof adapters.provider?.verifyDeliveredContinuation!=='function') fail('trusted successor identity and verifier are required','ADAPTER_MISSING');
  const fenced=createLegacyFencedLedgerStore({stateRoot,unit,requestDigest:request.fenceDigest,adapters});
  const ledgers=createLedgerStore(stateRoot);
  return fenced.withLock(unit,async priorLedger=>{
    if(priorLedger.reconcileOnly || priorLedger.fenceUnitDigest!==request.unitDigest || priorLedger.fenceGoalDigest!==request.goalDigest)
      fail('fence does not bind the unchanged predecessor and goal','CONTINUITY_STALE');
    const prior=await priorLedger.readRetainedUnit();
    return ledgers.withLock(request.successor,async nextLedger=>store.withLock(request.successor,async next=>{
      if(prior.state!=='Delivered'||prior.continuity?.goalId!==request.goalId||!prior.accepted||!prior.deliveryResult
        || next.continuity?.goalId!==request.goalId||!['Scoped','Implementing','SelfGated','InReview','Accepted'].includes(next.state)
        || next.sessionFinalization||next.deliveryResult||effectArgsDigest(prior)!==request.unitDigest||effectArgsDigest(next)!==request.successorDigest)
        fail('delivered predecessor or successor changed','CONTINUITY_STALE');
      if(effectArgsDigest(nativeOwner(prior.sessionFinalization?.owner))!==effectArgsDigest(owner)
        ||prior.sessionFinalization?.recipient?.sessionId===owner.sessionId)
        fail('follow-up must retain the existing product owner','SESSION_OWNER_MISMATCH');
      if(unresolved(await priorLedger.read())||unresolved(await nextLedger.read())) fail('unresolved effects require reconciliation','EFFECT_UNCERTAIN');
      return goals.transaction(request.goalId,async goal=>{
        const existing=goal?.transfers?.find(item=>item.unit===unit);
        if(existing?.deliveredContinuation===true&&existing.requestDigest===requestDigest) return goal;
        if(!goal||goal.goal.status!=='active'||goal.goal.remaining[0]!==unit||goal.goal.remaining[1]!==request.successor
          ||effectArgsDigest(goal)!==request.goalDigest||existing||goalOwner(goal,request.successor)) fail('goal cursor or successor custody changed','CONTINUITY_STALE');
        const execution=selectExecutionPolicy(goal.policy,'implementation');
        if(owner.runtime!==execution.runtime||path.basename(owner.worker.executable)!==execution.provider||await realpath(owner.cwd)!==owner.cwd)
          fail('successor owner differs from execution policy','CONTINUITY_STALE');
        const verifySources=async()=>{for(const source of [goal.source,...(next.canon??[])]){
          const file=path.resolve(owner.cwd,source.path??'');
          if(!sha(source.digest)||`sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`!==source.digest)fail('canonical source changed','CONTINUITY_STALE');
        }};
        const verifyTarget=async()=>{const target=await adapters.git.inspectUnit({unit:request.successor,record:next});
          if(!path.isAbsolute(target?.repo??'')||await realpath(target.repo)!==owner.cwd||!target.branch
            ||effectArgsDigest(target??null)!==request.targetDigest||next.head&&(target?.head!==next.head||target?.contentFingerprint!==next.contentFingerprint))
            fail('successor target changed','CONTINUITY_STALE');
        };
        await verifySources();await verifyTarget();
        const binding={unit,goalId:request.goalId,successor:request.successor,userInputRef,argsDigest:requestDigest,unitDigest:request.unitDigest,
          successorDigest:request.successorDigest,goalDigest:request.goalDigest,targetDigest:request.targetDigest,fenceDigest:request.fenceDigest,ownerDigest:effectArgsDigest(owner),policyDigest:effectArgsDigest(goal.policy)};
        const observe=async()=>{const actual=nativeOwner(await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd}));if(effectArgsDigest(actual)!==binding.ownerDigest)fail('successor owner changed','SESSION_OWNER_MISMATCH');};
        await observe();await verifyApprovalInput(adapters.provider,{...binding,effect:'goal.delivered.continue',reason:request.reason});
        const proof=await adapters.provider.verifyDeliveredContinuation({...binding,request:structuredClone(request),prior:structuredClone(prior),next:structuredClone(next),goal:structuredClone(goal)});
        if(proof?.verified!==true||proof.executionAccountVerified!==true||proof.targetVerified!==true||proof.originalDeliveryVerified!==true
          ||Object.entries(binding).some(([key,value])=>proof[key]!==value))fail('delivered continuation is unproven','CONTINUITY_UNPROVEN');
        await verifySources();await verifyTarget();await observe();if(unresolved(await priorLedger.read())||unresolved(await nextLedger.read()))fail('effects changed during continuation','EFFECT_UNCERTAIN');
        const adoption={id:request.id,unit:request.successor,ownership:'existing',...owner,owner,requestDigest,userInputRef,goalRevision:goal.revision+1,policyDigest:effectArgsDigest(goal.policy)};
        const transfer={unit,successor:request.successor,deliveredContinuation:true,unitDigest:request.unitDigest,requestDigest,userInputRef};
        return {...goal,revision:goal.revision+1,goal:{...goal.goal,remaining:goal.goal.remaining.slice(1)},adoptions:[...(goal.adoptions??[]),adoption],transfers:[...(goal.transfers??[]),transfer]};
      });
    }));
  });
}
