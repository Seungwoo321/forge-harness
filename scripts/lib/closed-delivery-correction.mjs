import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createLedgerStore,unresolvedEffect} from './ledger.mjs';
import {goalOwner,nativeOwner} from './continuity-custody.mjs';
import {resolvePolicy} from './policy.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'CLOSED_DELIVERY_CORRECTION_UNPROVEN'});};
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function reopenedGoal(prior,receipt){
  const {completion,...rest}=prior;
  return {...rest,revision:prior.revision+1,goal:{...prior.goal,status:'active',remaining:[receipt.unit]},closedDeliveryCorrections:[...(prior.closedDeliveryCorrections??[]),{id:receipt.id,unit:receipt.unit,requestDigest:receipt.requestDigest,checkpointDigest:effectArgsDigest(receipt),priorCompletion:completion,priorGoal:prior.goal}]};
}
export async function correctClosedDeliveryOmission({stateRoot,store,unit,request,userInputRef,adapters}) {
  const keys=['kind','id','expectedRevision','expectedGoalRevision','targetDigest','finishRequest','provenance','correctionPaths','requestedDelivery','owner','reason'];
  if(Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.requestedDelivery!=='merge'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id??'')||['.','..'].includes(request.id)
    ||![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
    ||!/^sha256:[a-f0-9]{64}$/.test(request.targetDigest??'')||!userInputRef||!request.reason
    ||!Array.isArray(request.correctionPaths)||!request.correctionPaths.length
    ||request.correctionPaths.some(p=>typeof p!=='string'||!p||p.startsWith('/')||p.includes('\\')||p.split('/').some(s=>['.','..',''].includes(s))))fail('exact omission correction request required');
  const checkFile=async ref=>{if(!path.isAbsolute(ref?.path??'')||!/^sha256:[a-f0-9]{64}$/.test(ref.digest??''))fail('exact source reference required');const b=await readFile(ref.path);if(hash(b)!==ref.digest)fail('source changed');return b;};
  const payload=JSON.parse(await checkFile(request.finishRequest));await checkFile(request.provenance);
  if(Object.hasOwn(payload,'requestedDelivery')||!payload.delivery||!Object.keys(payload.delivery).some(k=>['message','title','body'].includes(k))||payload.goalComplete!==true)fail('original supplied delivery must omit requestedDelivery');
  if(typeof adapters.provider?.verifyClosedDeliveryCorrection!=='function'||typeof adapters.session?.observe!=='function'||typeof adapters.git?.inspectUnit!=='function')fail('trusted correction providers required');
  const requestDigest=effectArgsDigest({request,userInputRef}),goals=createContinuityStore(stateRoot),duplicate=new Error('duplicate correction');let receipt;
  try{await createLedgerStore(stateRoot).withLock(unit,async ledger=>{
    const rows=await ledger.read();
    await store.update(unit,async record=>{
      const old=record.completionRecoveries?.find(r=>r.id===request.id);
      if(old){if(old.requestDigest!==requestDigest)fail('correction id conflicts');receipt={...old,duplicate:true};throw duplicate;}
      if(record.state!=='Closed'||record.revision!==request.expectedRevision||['review','ops'].includes(record.kind)
        ||!record.accepted||record.deliveryResult?.level!=='none'||record.deliveryResult.effectRefs?.length
        ||(record.deliveryPlan!=null&&record.deliveryPlan.level!=='none')||resolvePolicy({unit:record.policyOverrides??{},project:record.policy??{}},{nonInteractive:true}).policy.delivery!=='merge'||record.sessionFinalization||record.next||!record.continuity?.goalId)fail('only the original Closed merge-cap omission is eligible');
      if(unresolvedEffect(rows)||rows.some(r=>r.event==='intent'&&['git.commit','git.push','git.integrate','pr.create','pr.merge','session.close','session.deliver'].includes(r.effect)))fail('effects are not settled or delivery/close already started');
      const owner=nativeOwner(request.owner),custody=goalOwner(await goals.read(record.continuity.goalId),unit);
      if(['sessionId','incarnationId','cwd'].some(k=>owner[k]!==custody?.[k]||payload.parentRuntime?.[k]!==owner[k]))fail('original owner differs');
      const observe=async()=>{if(effectArgsDigest(nativeOwner(await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd})))!==effectArgsDigest(owner))fail('live original owner changed');};
      const target=await adapters.git.inspectUnit({unit,record});
      if(effectArgsDigest(target)!==request.targetDigest)fail('current full target changed');
      const diff=await adapters.command('git',['diff','--no-ext-diff','--no-textconv','--name-only','-z',record.accepted.tree,target.tree,'--'],{cwd:owner.cwd});
      if(diff.exitCode!==0||diff.stdout.split('\0').filter(Boolean).some(p=>!request.correctionPaths.includes(p)))fail('target changes escape correction scope');
      const current=await goals.read(record.continuity.goalId),checkpoint=rows.find(r=>r.event==='goal-completion-recovery'&&r.id===request.id);
      if(checkpoint&&(checkpoint.requestDigest!==requestDigest||checkpoint.unitDigest!==effectArgsDigest(record)
        ||effectArgsDigest(checkpoint.target)!==request.targetDigest||!checkpoint.priorGoal||checkpoint.goalDigest!==effectArgsDigest(checkpoint.priorGoal)))fail('original correction checkpoint changed');
      const verify=async goal=>{
        await checkFile(request.finishRequest);await checkFile(request.provenance);await observe();
        const binding={unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),ledgerDigest:effectArgsDigest(rows),targetDigest:request.targetDigest,ownerDigest:effectArgsDigest(owner),finishRequestDigest:request.finishRequest.digest,provenanceDigest:request.provenance.digest,requestedDelivery:'merge'};
        await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.closed.delivery.correct',reason:request.reason});
        const proof=await adapters.provider.verifyClosedDeliveryCorrection({...binding,request,record,goal,target,rows,payload,...(checkpoint?{checkpoint}:{})});
        if(proof?.verified!==true||Object.entries(binding).some(([k,v])=>proof[k]!==v)
          ||!['originalPayloadVerified','noRemoteEffects','ownerAlive','closeNotApplied','oldExecutionSettled','queueSettled'].every(k=>proof[k]===true))fail('exact sourced omission/owner/effect proof missing');
        await checkFile(request.finishRequest);await checkFile(request.provenance);await observe();
        if(effectArgsDigest(await adapters.git.inspectUnit({unit,record}))!==request.targetDigest)fail('target drifted during verification');
        if(effectArgsDigest(await goals.read(record.continuity.goalId))!==effectArgsDigest(goal))fail('goal drifted during verification');
        return {binding,proof};
      };
      const resumed=current?.closedDeliveryCorrections?.find(r=>r.id===request.id);
      if(resumed){
        if(!checkpoint||resumed.requestDigest!==requestDigest||resumed.checkpointDigest!==effectArgsDigest(checkpoint)
          ||checkpoint.unitDigest!==effectArgsDigest(record)||!checkpoint.priorGoal||checkpoint.goalDigest!==effectArgsDigest(checkpoint.priorGoal)
          ||effectArgsDigest(current)!==effectArgsDigest(reopenedGoal(checkpoint.priorGoal,checkpoint)))fail('correction checkpoint or post-goal relation changed');
        const {proof}=await verify(current);
        await ledger.append({event:'closed-delivery-revalidation',id:request.id,requestDigest,proof,at:adapters.now()});
        receipt=checkpoint;
      }
      else{
        if(current?.revision!==request.expectedGoalRevision||current.goal.status!=='complete'||current.goal.remaining.length
          ||current.completion?.unit!==unit||current.completionReservation||current.reworkReservation
          ||current.transfers?.some(t=>t.unit===unit)||effectArgsDigest(current.completion.proof)!==effectArgsDigest(record.goalCompletion?.proof)
          ||effectArgsDigest(payload.goalProof)!==effectArgsDigest(record.goalCompletion?.proof))fail('original completed goal or proof changed');
        const resultBytes=await readFile(record.resultRef.path);
        if(hash(resultBytes)!==record.resultRef.digest||resultBytes.toString()!==`${record.result}\n`)fail('original Closed result changed');
        const {binding,proof}=await verify(current);
        receipt=checkpoint??{event:'goal-completion-recovery',kind:request.kind,id:request.id,unit,seq:null,key:null,request,requestDigest,userInputRef,unitDigest:binding.unitDigest,goalDigest:binding.goalDigest,target,proof,prior:structuredClone(record),priorGoal:structuredClone(current),at:adapters.now()};
        if(checkpoint&&checkpoint.requestDigest!==requestDigest)fail('checkpoint request changed');
        if(!checkpoint)await ledger.append(receipt);
        await goals.transaction(current.goal.id,goal=>{
          if(effectArgsDigest(goal)!==binding.goalDigest)fail('goal changed during correction');
          return reopenedGoal(goal,receipt);
        });
      }
      const latest=new Map((record.evidence??[]).map(e=>[e.gate,e]));
      return {...record,state:'Implementing',head:target.head,contentFingerprint:target.contentFingerprint,accepted:null,deliveryResult:null,deliveryPlan:null,goalCompletion:null,result:null,resultRef:null,next:null,terminalProjection:null,reviewDecision:null,reviewedHead:null,verdict:null,diff:null,handoff:null,
        evidence:[...(record.evidence??[]),...[...latest.values()].map(e=>({...e,status:'stale',covers:[]}))],completionRecoveries:[...(record.completionRecoveries??[]),receipt]};
    });
  });}catch(error){if(error!==duplicate)throw error;}
  return receipt;
}
