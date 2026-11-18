import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { createLedgerStore, unresolvedEffect } from './ledger.mjs';
import { goalOwner, nativeOwner } from './continuity-custody.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';

const fail = (message, code = 'AUTHORITY_CORRECTION_INVALID') => { throw Object.assign(new Error(message), {code}); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
async function verifySource(source) {
  if (!path.isAbsolute(source?.path ?? '') || !sha(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest)
    fail('canonical source changed', 'AUTHORITY_CORRECTION_STALE');
}

// A single append to the goal; custody and the entire unit remain untouched.
export async function correctGoalAuthority({stateRoot, store, unit, goalId, kind, request, userInputRef, adapters, cwd}) {
  const keys = ['id','unit','expectedRevision','expectedGoalRevision','unitDigest','goalDigest','targetDigest','original','provenance','reason',...(Object.hasOwn(request ?? {},'completionProof') ? ['completionProof'] : [])];
  if (!['adoption','amendment'].includes(kind) || !request || Object.keys(request).sort().join(',') !== keys.sort().join(',')
    || typeof request.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id) || ['.','..'].includes(request.id)
    || request.unit !== unit || !text(unit) || !text(userInputRef) || !text(request.reason)
    || ![request.expectedRevision,request.expectedGoalRevision].every(n => Number.isSafeInteger(n) && n > 0)
    || ![request.unitDigest,request.goalDigest,request.targetDigest,request.original?.digest,request.provenance?.digest].every(sha)
    || Object.keys(request.original ?? {}).sort().join(',') !== 'digest,index' || !Number.isSafeInteger(request.original.index) || request.original.index < 0
    || request.completionProof !== undefined && (Object.keys(request.completionProof ?? {}).sort().join(',') !== 'digest,ref'
      || !path.isAbsolute(request.completionProof.ref ?? '') || !sha(request.completionProof.digest))
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,ref' || !text(request.provenance.ref) || !path.isAbsolute(request.provenance.ref)) fail('exact correction request and original human input are required');
  if (typeof adapters.provider?.verifyAuthorityCorrection !== 'function') fail('contextual authority verifier is required','ADAPTER_MISSING');
  const goals = createContinuityStore(stateRoot), requestDigest = effectArgsDigest({kind,request,userInputRef});
  return createLedgerStore(stateRoot).withLock(unit, async ledger => store.withLock(unit, async record => {
    const completed = record.state === 'Closed';
    if (!record.continuity?.goalId || goalId && goalId !== record.continuity.goalId || ['review','ops'].includes(record.kind)
      || !completed && (!['Scoped','Implementing','SelfGated','InReview','Accepted'].includes(record.state)
      || record.deliveryPlan || record.deliveryResult || record.sessionFinalization)) fail('current undelivered goal-bound change unit required');
    const rows = await ledger.read();
    if (unresolvedEffect(rows)) fail('reconcile uncertain effects first','EFFECT_UNCERTAIN');
    let receipt;
    await goals.transaction(record.continuity.goalId, async goal => {
      if (!goal) fail('goal is unavailable');
      if (completed) {
        if (!request.completionProof || goal.goal.status !== 'complete' || goal.goal.remaining.length || goal.completion?.unit !== unit
          || record.goalCompletion?.goalId !== goal.goal.id || !Array.isArray(goal.completion.proof)
          || effectArgsDigest(goal.completion.proof) !== effectArgsDigest(record.goalCompletion.proof)
          || !record.accepted?.head || !record.accepted.contentFingerprint || record.head !== record.accepted.head
          || record.contentFingerprint !== record.accepted.contentFingerprint || !record.resultRef)
          fail('fully completed target and historical acceptance proof required');
        if (typeof adapters.provider?.verifyCompletedAuthorityTarget !== 'function') fail('historical target and native proof verifier required','ADAPTER_MISSING');
      } else {
        if (request.completionProof || goal.goal.status !== 'active' || goal.goal.remaining[0] !== unit) fail('unit must be the active goal target');
        if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.session?.observe !== 'function')
          fail('live target and native owner verifiers required','ADAPTER_MISSING');
      }
      const corrections = goal.authorityCorrections ?? [], prior = corrections.find(item => item.id === request.id);
      if (prior && prior.requestDigest !== requestDigest) fail('correction id binds another request','AUTHORITY_CORRECTION_CONFLICT');
      if (record.revision !== request.expectedRevision || effectArgsDigest(record) !== request.unitDigest) fail('unit changed','AUTHORITY_CORRECTION_STALE');
      const before = structuredClone(goal);
      if (prior) {
        if (corrections.at(-1) !== prior || goal.revision !== request.expectedGoalRevision + 1) fail('goal changed after correction','AUTHORITY_CORRECTION_STALE');
        before.revision = request.expectedGoalRevision;
        if (prior.hadCorrections) before.authorityCorrections.pop(); else delete before.authorityCorrections;
      }
      if (before.revision !== request.expectedGoalRevision || effectArgsDigest(before) !== request.goalDigest) fail('goal changed','AUTHORITY_CORRECTION_STALE');
      const original = goal[kind === 'adoption' ? 'adoptions' : 'amendments']?.[request.original.index];
      if (!original || effectArgsDigest(original) !== request.original.digest || !text(original.userInputRef) || original.userInputRef === userInputRef
        || corrections.some(item => item !== prior && item.kind === kind && item.request.original.index === request.original.index)) fail('original receipt changed or already corrected','AUTHORITY_CORRECTION_CONFLICT');
      const custody = goalOwner(goal,unit);
      if (!custody || kind === 'adoption' && (original.unit !== unit || effectArgsDigest(custody) !== request.original.digest)) fail('original adoption is not current custody','AUTHORITY_CORRECTION_CONFLICT');
      const owner = nativeOwner(custody.owner ?? custody), ownerDigest = effectArgsDigest(owner);
      if (!cwd || await realpath(cwd) !== owner.cwd) fail('correction must run in the current native owner cwd');
      const executionPolicy = custody.policyDigest
        ? [goal.policy,...(goal.policyChanges ?? []).map(change=>change.previous)].find(policy=>effectArgsDigest(policy) === custody.policyDigest)
        : goal.policy;
      if (!executionPolicy) fail('custody execution policy is unavailable');
      const execution = selectExecutionPolicy(executionPolicy,'implementation');
      if (owner.runtime !== execution.runtime || path.basename(owner.worker.executable) !== execution.provider) fail('current owner execution policy mismatch');
      const sources = [goal.source,{path:request.provenance.ref,digest:request.provenance.digest},...(completed ? [record.resultRef,{path:request.completionProof.ref,digest:request.completionProof.digest}] : []),...(record.canon ?? []).map(source => ({...source,path:path.resolve(cwd,source.path ?? '')}))];
      const binding = {unit,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:request.unitDigest,goalDigest:request.goalDigest,
        originalDigest:request.original.digest,previousUserInputRef:original.userInputRef,targetDigest:request.targetDigest,
        ownerDigest,policyDigest:effectArgsDigest(executionPolicy),sourceDigest:effectArgsDigest(sources),provenanceDigest:request.provenance.digest,kind,mode:completed ? 'completed' : 'live',
        completionDigest:completed ? effectArgsDigest({completion:goal.completion,goalCompletion:record.goalCompletion,resultRef:record.resultRef,completionProof:request.completionProof,ledger:rows}) : null};
      const observe = async () => {
        for (const source of sources) await verifySource(source);
        if (completed) {
          const target = structuredClone(record.accepted);
          if (effectArgsDigest(target) !== request.targetDigest) fail('historical accepted target changed','AUTHORITY_CORRECTION_STALE');
          const verified = await adapters.provider.verifyCompletedAuthorityTarget({...binding,record:structuredClone(record),goal:structuredClone(before),
            owner:structuredClone(owner),target,completionProof:structuredClone(request.completionProof),ledger:structuredClone(rows)});
          if (verified?.verified !== true || Object.entries(binding).some(([key,value])=>verified[key] !== value))
            fail('historical target and native completion proof are unverified','AUTHORITY_CORRECTION_UNPROVEN');
          return target;
        }
        const target = await adapters.git.inspectUnit({unit,record});
        if (!target?.head || !target.contentFingerprint || effectArgsDigest(target) !== request.targetDigest) fail('live target changed','AUTHORITY_CORRECTION_STALE');
        if (effectArgsDigest(nativeOwner(await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd}))) !== ownerDigest)
          fail('actual native owner changed','SESSION_OWNER_MISMATCH');
        return target;
      };
      const target = await observe();
      await verifyApprovalInput(adapters.provider,{...binding,effect:kind === 'adoption' ? 'unit.session.approval.correct' : 'goal.approval.correct',reason:request.reason});
      // Old amendment rows store the previous definition; the following row (or current goal) supplies its exact result.
      const result = kind === 'amendment' ? goal.amendments[request.original.index + 1]?.previous ?? {objective:goal.goal.objective,criteria:goal.goal.criteria} : null;
      const verified = await adapters.provider.verifyAuthorityCorrection({...binding,request:structuredClone(request),record:structuredClone(record),
        goal:before,original:structuredClone(original),result:structuredClone(result),owner:structuredClone(owner),target:structuredClone(target)});
      if (verified?.verified !== true || Object.entries(binding).some(([key,value]) => verified[key] !== value)) fail('original misattribution and exact human authority are unverified','AUTHORITY_CORRECTION_UNPROVEN');
      await observe();
      if (!completed && effectArgsDigest(await adapters.git.inspectUnit({unit,record})) !== request.targetDigest)
        fail('live target changed','AUTHORITY_CORRECTION_STALE');
      for (const source of sources) await verifySource(source);
      if (prior) { receipt = {...prior,duplicate:true}; return goal; }
      receipt = {id:request.id,kind,unit,request:structuredClone(request),requestDigest,userInputRef,original:structuredClone(original),result,
        ownerDigest,mode:binding.mode,completionDigest:binding.completionDigest,policyDigest:binding.policyDigest,sourceDigest:binding.sourceDigest,goalRevision:goal.revision+1,hadCorrections:Object.hasOwn(goal,'authorityCorrections')};
      return {...goal,revision:goal.revision+1,authorityCorrections:[...corrections,receipt]};
    });
    return receipt;
  }));
}
