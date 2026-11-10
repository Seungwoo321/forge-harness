import {createLegacyFencedLedgerStore} from './legacy-fence.mjs';
import {executeEffect} from './ledger.mjs';
import {authorizeEffect,prepareEffect,resolvePolicy} from './policy.mjs';
import {validateTaskReceipt} from './session-task.mjs';

// Reconcile the existing native delivery only; this path never submits a new task.
export async function reconcileLegacyDelivery({stateRoot,unit,fenceDigest,userInputRef,adapters}) {
 if(typeof adapters?.session?.verify!=='function'||typeof adapters?.now!=='function')
  throw Object.assign(new Error('trusted session observation is required'),{code:'ADAPTER_MISSING'});
 const ledger=createLegacyFencedLedgerStore({stateRoot,unit,requestDigest:fenceDigest,adapters});
 let submissionBinding;
 const validate=(result,input)=>{
  validateTaskReceipt(result,input);
  const recipient=input.args.recipient;
  if(!recipient||result.sessionId!==recipient.sessionId||result.incarnationId!==recipient.incarnationId
    ||recipient.worker?.threadId&&result.task?.threadId!==recipient.worker.threadId
    ||!submissionBinding||result.task?.threadId!==submissionBinding.threadId||result.task?.promptDigest!==submissionBinding.promptDigest
    ||!Array.isArray(result.task?.packets)||!Array.isArray(submissionBinding.packets)
    ||result.task.packets.some(packet=>!submissionBinding.packets.some(bound=>bound.path===packet.path&&bound.digest===packet.digest)))
   throw Object.assign(new Error('delivery recipient identity differs from the original intent'),{code:'SESSION_TASK_UNVERIFIED'});
  return result;
 };
 const {record,intent,existing}=await ledger.withLock(unit,async locked=>{
  const record=await locked.readRetainedUnit(),rows=await locked.read();
  if(!userInputRef||locked.fenceUserInputRef!==userInputRef)throw Object.assign(new Error('delivery authorization differs from the fence'),{code:'LEGACY_FENCE_UNPROVEN'});
  const intents=rows.filter(row=>row.event==='intent'&&row.effect==='session.deliver');
  const intent=intents.at(-1);
  if(!intent||prepareEffect('session.deliver',intent.args).key!==intent.key)
   throw Object.assign(new Error('original delivery is not the fenced reconciliation target'),{code:'EFFECT_UNCERTAIN'});
  const submissions=rows.filter(row=>row.event==='submission'&&row.seq===intent.seq&&row.key===intent.key);
  if(submissions.length!==1||!submissions[0].binding?.threadId||!submissions[0].binding?.promptDigest)
   throw Object.assign(new Error('original delivery submission is not unique'),{code:'EFFECT_UNCERTAIN'});
  submissionBinding=submissions[0].binding;
  const existing=rows.findLast(row=>row.event==='result'&&row.seq===intent.seq&&row.key===intent.key);
  if(!locked.reconcileOnly&&!existing)throw Object.assign(new Error('original delivery has no receipt'),{code:'EFFECT_UNCERTAIN'});
  if(existing)validate(existing.result,{effect:'session.deliver',args:intent.args,key:intent.key});
  return {record,intent,existing};
 });
 const {policy}=resolvePolicy({unit:record.policyOverrides??{},project:record.policy??{}},{nonInteractive:true});
 const authorization=authorizeEffect(policy,'session.deliver',{explicitUserInstruction:true,productOwned:true});
 if(!authorization.allowed)throw Object.assign(new Error(authorization.reason),{code:'EFFECT_DENIED'});
 if(existing)return {status:'duplicate',key:intent.key,seq:intent.seq,result:existing.result};
 return executeEffect({unit,effect:'session.deliver',args:intent.args,policy,
  context:{explicitUserInstruction:true,productOwned:true},store:ledger,
  adapter:{now:adapters.now,async execute(){throw Object.assign(new Error('reconciliation cannot submit a task'),{code:'LEGACY_LEASE_READ_ONLY'});},
   async verify(input){const result=await adapters.session.verify(input);if(result?.status==='completed')validate(result.result,input);return result;}}});
}
