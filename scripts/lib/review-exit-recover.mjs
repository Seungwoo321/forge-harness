import path from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectArgsDigest as digest,verifyApprovalInput} from './approvals.mjs';
import {createLedgerStore,unresolvedEffect,sessionEffectRetired} from './ledger.mjs';
import {acquireContinuityLock} from './continuity-lock.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {goalOwner,nativeOwner} from './continuity-custody.mjs';
import {taskPackets,validateTaskReceipt} from './session-task.mjs';
import {loadManagedLaunch} from './continuity-launch-io.mjs';
import {prepareEffect} from './policy.mjs';
import {retiredReviewFinalization,originalReviewDeliveryArgs} from './review-exit-audit.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'CUSTODY_UNPROVEN'});};
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)&&!['.','..'].includes(value);
const sha=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const receiver=owner=>({runtime:owner.runtime,sessionId:owner.sessionId,incarnationId:owner.incarnationId,cwd:owner.cwd,threadId:owner.worker.threadId,pid:owner.worker.pid,executable:owner.worker.executable});
const sameIdentity=(left,right)=>['runtime','sessionId','incarnationId','cwd'].every(key=>left?.[key]===right[key])
  && ['executable','pid','threadId'].every(key=>left.worker?.[key]===right.worker[key]);

async function withGoalReadLock(stateRoot,goalId,action) {
  const guard=await acquireContinuityLock(path.resolve(stateRoot,'goals',goalId,'.lock'));
  try {return await action(await createContinuityStore(stateRoot).read(goalId),guard);}
  finally {await guard.close();}
}

export async function recoverExitedReviewFinalization({stateRoot,store,unit,request,userInputRef,adapters,cwd}) {
  if(!id(unit)||!request||Object.keys(request).sort().join(',')!=='expectedGoalRevision,expectedRevision,goalDigest,id,ledgerDigest,owner,previousCustodyDigest,provenance,reason,targetDigest,unitDigest'
    || !id(request.id)||![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
    || !['unitDigest','goalDigest','ledgerDigest','previousCustodyDigest','targetDigest'].every(key=>sha(request[key]))
    || Object.keys(request.provenance??{}).sort().join(',')!=='digest,path'||!path.isAbsolute(request.provenance.path??'')||!sha(request.provenance.digest)
    || typeof request.reason!=='string'||!request.reason.trim()||typeof userInputRef!=='string'||!userInputRef.trim())fail('exact exited-review request and original continuation authority required');
  if(typeof adapters.provider?.verifyExitedReviewFinalizationRecovery!=='function'||typeof adapters.session?.observe!=='function'||typeof adapters.git?.inspectUnit!=='function')fail('trusted exited-review native and authorization verifiers required');
  const owner=nativeOwner(request.owner);
  if(digest(owner)!==digest(request.owner)||owner.runtime!=='cmux'||await realpath(cwd)!==owner.cwd)fail('exact current replacement caller required');
  const ledgers=createLedgerStore(stateRoot),requestDigest=digest({request,userInputRef});
  let receipt;
  return ledgers.withLock(unit,ledger=>store.withLock(unit,async(record,assertReviewHeld)=>{
    const plan=record.sessionFinalization,attempt=record.stages?.find(stage=>stage.name==='review')?.attempts?.at(-1);
    if(record.kind!=='review'||record.state!=='Closed'||plan?.mode!=='review'||plan.closeReceipt||plan.retainedOwner||plan.sessionStart
      || !id(record.targetUnit)||record.targetUnit===unit||!id(record.continuity?.goalId)
      || !attempt?.endedAt||attempt.result!=='done'||!sha(attempt.outputDigest)||!attempt.submissionId)fail('original submitted Closed managed review required');
    if(record.revision!==request.expectedRevision||digest(record)!==request.unitDigest)fail('original review changed');
    const all=await ledger.read(),prior=all.findLast(row=>row.event==='review-finalization-recovery');
    if(prior&&(prior.id!==request.id||prior.requestDigest!==requestDigest||prior!==all.at(-1)))fail('original retirement audit differs');
    const rows=prior?all.slice(0,-1):all;
    if(digest(rows)!==request.ledgerDigest)fail('original full ledger changed');
    const intents=rows.filter(row=>row.event==='intent'),intent=intents.at(-1),start=intents[0];
    const submission=rows.findLast(row=>row.event==='submission'&&row.seq===start?.seq&&row.key===start?.key);
    const started=rows.findLast(row=>row.event==='result'&&row.seq===start?.seq&&row.key===start?.key);
    if(intents.length!==2||start?.effect!=='session.start'||intent?.effect!=='session.deliver'||unresolvedEffect(rows)!==intent
      || sessionEffectRetired(rows,intent)||rows.some(row=>row.key===intent.key&&row.seq===intent.seq&&['submission','result'].includes(row.event))
      || !submission?.binding||!started?.result||prepareEffect(start.effect,start.args).key!==start.key||prepareEffect(intent.effect,intent.args).key!==intent.key)fail('only the original unresolved unsubmitted return transport may be retired');
    validateTaskReceipt(started.result,{effect:start.effect,args:start.args,key:start.key});
    const b=submission.binding;
    const old=nativeOwner({runtime:b.runtime,sessionId:b.sessionId,incarnationId:b.incarnationId,cwd:b.cwd,worker:{executable:b.executable,pid:b.pid,threadId:b.threadId,incarnationId:b.incarnationId}});
    const startupIdentity={...started.result,worker:started.result.worker??{executable:started.result.executable,pid:started.result.pid,threadId:started.result.task.threadId}};
    if(!sameIdentity(plan.owner,old)||!sameIdentity(startupIdentity,old)||started.result.task.threadId!==old.worker.threadId||old.cwd!==owner.cwd||old.worker.threadId===owner.worker.threadId)fail('original reviewer native identity changed');
    const inputPath=path.resolve(stateRoot,'units',unit,attempt.inputPath);
    if(path.dirname(inputPath)!==path.resolve(stateRoot,'units',unit,'stages'))fail('original stage input path changed');
    const input=JSON.parse(await readFile(inputPath,'utf8')),{inputDigest,...envelope}=input;
    if(inputDigest!==attempt.inputDigest||digest(envelope)!==inputDigest||input.unit!==unit||input.targetUnit!==record.targetUnit||input.stage!=='review'||input.attempt!==attempt.n)fail('original submitted stage binding changed');
    await loadManagedLaunch(start.args);await taskPackets(plan);
    if(digest(intent.args)!==digest(originalReviewDeliveryArgs(record)))fail('original complete return intent no longer matches original plan');
    return ledgers.withLock(record.targetUnit,()=>store.withLock(record.targetUnit,(target,assertTargetHeld)=>withGoalReadLock(stateRoot,record.continuity.goalId,async(goal,goalGuard)=>{
      const previous=goalOwner(goal,record.targetUnit),recipient=nativeOwner(previous?.owner),registered=goal.reviews?.find(item=>item.unit===unit&&item.effectKey===start.key);
      if(goal.goal.status!=='active'||goal.goal.remaining[0]!==record.targetUnit||goal.revision!==request.expectedGoalRevision||digest(goal)!==request.goalDigest
        || digest(previous)!==request.previousCustodyDigest||previous.ownership!=='existing'||digest(target)!==request.targetDigest
        || !sameIdentity(plan.recipient,recipient)||digest(plan.recipientCustody)!==digest(previous)
        || !registered||registered.nativeThreadId!==old.worker.threadId||registered.sessionId!==old.sessionId||registered.incarnationId!==old.incarnationId||registered.cwd!==old.cwd
        || registered.targetDigest!==start.args.targetDigest||registered.goalDigest!==start.args.goalDigest||registered.goalPath!==start.args.goalPath
        || recipient.cwd!==owner.cwd||recipient.worker.threadId===owner.worker.threadId)fail('exact original recipient custody, startup and current target required');
      const original=JSON.parse(await readFile(start.args.goalPath,'utf8'));
      if(digest(original.source)!==digest(goal.source))fail('original review source changed');
      const targetGit=await adapters.git.inspectUnit({unit:target.unit,record:target});
      if(target.head!==targetGit.head||target.contentFingerprint!==targetGit.contentFingerprint)fail('current submitted Git target changed');
      const check=async()=>{
        if(hash(await readFile(goal.source.path))!==goal.source.digest||hash(await readFile(request.provenance.path))!==request.provenance.digest
          || digest(await adapters.git.inspectUnit({unit:target.unit,record:target}))!==digest(targetGit))fail('source, evidence or current target changed');
        for(const previousOwner of [old,recipient]){
          const observed=await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd,exitedOwner:previousOwner});
          if(observed.previousOwnerExited!==true||digest(nativeOwner(observed))!==digest(owner))fail('both original native owners must remain exited and replacement caller exact');
        }
        await taskPackets(plan);await loadManagedLaunch(start.args);
        const checked=JSON.parse(await readFile(inputPath,'utf8'));
        if(digest(checked)!==digest(input))fail('original submitted stage changed');
      };
      const binding={unit,targetUnit:target.unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:request.unitDigest,goalDigest:request.goalDigest,targetDigest:request.targetDigest,gitTargetDigest:digest(targetGit),
        ledgerDigest:request.ledgerDigest,previousCustodyDigest:request.previousCustodyDigest,ownerDigest:digest(owner),intentDigest:digest(intent),planDigest:digest(plan),provenanceDigest:request.provenance.digest};
      await check();
      await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.review.exit.recover',reason:request.reason});
      const proof=await adapters.provider.verifyExitedReviewFinalizationRecovery({...binding,request:structuredClone(request),record:structuredClone(record),target:structuredClone(target),targetGit:structuredClone(targetGit),goal:structuredClone(goal),previousCustody:structuredClone(previous),intent:structuredClone(intent),rows:structuredClone(rows)});
      if(['taskNeverStarted','receiverSuspended','closed','deliveryCompleted'].some(key=>Object.hasOwn(proof??{},key))||Object.entries(binding).some(([key,value])=>proof?.[key]!==value)||proof.verified!==true||proof.receiverExited!==true||proof.recipientExited!==true||proof.ownerFenced!==true||proof.recipientFenced!==true
        ||proof.evidenceDigest!==request.provenance.digest||digest(proof.receiver)!==digest(receiver(old))||digest(proof.recipient)!==digest(receiver(recipient)))fail('original native work, authority and both exited owners are unproven');
      await check();
      const audit={event:'review-finalization-recovery',mode:'exited-review-finalization',id:request.id,unit,targetUnit:target.unit,goalId:goal.goal.id,seq:intent.seq,key:intent.key,effect:intent.effect,
        gitTargetDigest:binding.gitTargetDigest,intentDigest:binding.intentDigest,unitDigest:binding.unitDigest,planDigest:binding.planDigest,ledgerDigest:binding.ledgerDigest,sourceDigest:digest(goal.source),previousCustodyDigest:request.previousCustodyDigest,request:structuredClone(request),requestDigest,userInputRef,proof:structuredClone(proof)};
      if(!retiredReviewFinalization({reviewer:record,rows:[...rows,audit],goal}))fail('retirement audit does not preserve the original record');
      assertReviewHeld();assertTargetHeld();goalGuard.assertHeld();
      if(!prior)await ledger.append(audit);
      receipt={...(prior??audit),duplicate:Boolean(prior)};
      return goal;
    })),{wait:false});
  })).then(()=>receipt);
}
