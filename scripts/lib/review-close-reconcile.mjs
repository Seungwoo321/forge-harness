import {createLedgerStore, executeEffect, unresolvedEffect} from './ledger.mjs';
import {effectArgsDigest} from './approvals.mjs';
import {prepareEffect} from './policy.mjs';
import {taskPackets, validateTaskReceipt} from './session-task.mjs';

const fail = message => {throw Object.assign(new Error(message),{code:'EFFECT_UNCERTAIN'});};
const same = (a,b) => effectArgsDigest(a) === effectArgsDigest(b);

// Reconcile only existing review effects. No recipient observation or external execution is permitted.
export async function reconcileReviewClose({stateRoot,store,unit,record,policy,deliveryArgs,adapters}) {
  const plan=record.sessionFinalization;
  if(record.kind!=='review' || record.state!=='Closed' || plan.mode!=='review' || plan.retainedOwner || plan.sessionStart)
    fail('verification-only finalization requires a Closed managed review');
  const deliveryKey=prepareEffect('session.deliver',deliveryArgs).key;
  const closeArgs={owner:plan.owner,recipient:plan.recipient,session:plan.owner.sessionId,incarnation:plan.owner.incarnationId,
    resultDigest:plan.resultDigest,deliveryKey,...(deliveryArgs.recoveryEpoch?{recoveryEpoch:deliveryArgs.recoveryEpoch}:{})};
  const closeKey=prepareEffect('session.close',closeArgs).key;
  const validateClose=result=>{
    if(result?.closed!==true || result.sessionId!==plan.owner.sessionId || result.incarnationId!==plan.owner.incarnationId)
      fail('original close result is not exact');
    return result;
  };
  const ledgerStore=createLedgerStore(stateRoot);
  const closed=await ledgerStore.withLock(unit,ledger=>store.withLock(unit,async current=>{
    if(!same(current,record)) fail('original review changed before reconciliation');
    const rows=await ledger.read();
    const intent=rows.findLast(row=>row.event==='intent' && row.effect==='session.close' && row.key===closeKey);
    const delivered=rows.findLast(row=>row.event==='intent' && row.effect==='session.deliver' && row.key===deliveryKey);
    const receipt=delivered && rows.findLast(row=>row.event==='result' && row.seq===delivered.seq && row.key===deliveryKey);
    if(!intent || !same(intent.args,closeArgs) || !delivered || !same(delivered.args,deliveryArgs) || !receipt?.result)
      fail('exact original close intent and positive delivery receipt are required');
    validateTaskReceipt(receipt.result,{args:deliveryArgs,key:deliveryKey});
    if(receipt.result.sessionId!==plan.recipient.sessionId || receipt.result.incarnationId!==plan.recipient.incarnationId)
      fail('original delivery receipt names another recipient');
    const unresolved=unresolvedEffect(rows.filter(row=>row!==intent));
    if(unresolved) fail('another original effect remains unresolved');
    const verify=async input=>{
      const observed=await adapters.session.verify({...input,reconcileOnly:true});
      if(observed?.status==='completed')validateClose(observed.result);
      return observed?.status==='completed'?observed:{status:'unknown'};
    };
    const result=await executeEffect({unit,effect:'session.close',args:closeArgs,policy,
      context:{explicitUserInstruction:true,productOwned:true},
      store:{withLock:async(id,action)=>{
        if(id!==unit)fail('review identity changed');
        return action({...ledger,reconcileOnly:true,assertEffect:async input=>{
          if(input.phase!=='verify' || input.key!==intent.key || input.effect!==intent.effect)fail('verification-only finalization cannot create or execute an intent');
        }});
      }},
      adapter:{now:adapters.now,execute:async()=>fail('verification-only finalization cannot execute'),verify}});
    if(!['reconciled','duplicate'].includes(result.status))return null;
    validateClose(result.result);
    const checked=await verify({effect:'session.close',args:intent.args,key:intent.key,seq:intent.seq});
    if(checked.status!=='completed')return null;
    await taskPackets(plan);
    return result;
  }));
  if(!closed)return {code:3,state:record.state,finalizePending:true,summary:'Original close result remains unverified'};
  if(record.sessionFinalization.closeReceipt) {
    const prior=record.sessionFinalization.closeReceipt;
    if(prior.key!==closed.key || prior.seq!==closed.seq || !same(prior.result,closed.result))fail('original close receipt differs from verified result');
    return {code:0,state:record.state,resultPath:plan.resultPath,summary:'Original review closure already reconciled'};
  }
  await store.update(unit,current=>{
    if(!same(current,record))fail('original review changed before close receipt');
    return {...current,sessionFinalization:{...current.sessionFinalization,closeReceipt:closed}};
  });
  return {code:0,state:record.state,resultPath:plan.resultPath,summary:'Original review closure reconciled without execution'};
}
