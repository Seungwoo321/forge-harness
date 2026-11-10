import path from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';
import { goalOwner, nativeOwner } from './continuity-custody.mjs';
import { executionPoliciesEqual } from './continuity-decision.mjs';
import { attemptsFor } from './stage-attempts.mjs';

const fail = (message, code = 'POLICY_RECOVERY_INVALID') => { throw Object.assign(new Error(message), {code}); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => text(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['.', '..'].includes(value);
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
async function checkFile(source) {
  if (!path.isAbsolute(source?.path ?? '') || !sha(source.digest)
    || `sha256:${createHash('sha256').update(await readFile(source.path)).digest('hex')}` !== source.digest)
    fail('immutable source changed', 'POLICY_RECOVERY_STALE');
}

// Restoration changes only the goal, while the original submitted unit and its ledger remain locked and untouched.
export async function recoverGoalPolicy({stateRoot, store, goalId, request, userInputRef, adapters, cwd}) {
  const fields = ['id','unit','expectedRevision','expectedUnitRevision','goalDigest','unitDigest','targetDigest','changeRevision','changeDigest','owner','provenance','reason'];
  if (!request || Object.keys(request).sort().join(',') !== fields.sort().join(',')
    || !id(request.id) || !id(request.unit)
    || ![request.expectedRevision,request.expectedUnitRevision,request.changeRevision].every(n => Number.isSafeInteger(n) && n > 0)
    || ![request.goalDigest,request.unitDigest,request.targetDigest,request.changeDigest,request.provenance?.digest].every(sha)
    || Object.keys(request.provenance ?? {}).sort().join(',') !== 'digest,path'
    || !path.isAbsolute(request.provenance.path ?? '') || !text(request.reason) || !text(userInputRef))
    fail('exact goal, unit, refresh, target, owner, provenance and original authority are required');
  const owner = nativeOwner(request.owner), unit = request.unit;
  if (effectArgsDigest(owner) !== effectArgsDigest(request.owner) || !cwd || await realpath(cwd) !== owner.cwd)
    fail('recovery must run in the exact native owner cwd');
  if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.session?.observe !== 'function'
    || typeof adapters.provider?.verifyPolicyRefreshRecovery !== 'function') fail('trusted Git, native session and original-authority verifiers are required', 'ADAPTER_MISSING');
  const goals = createContinuityStore(stateRoot), requestDigest = effectArgsDigest({request,userInputRef});
  return createLedgerStore(stateRoot).withLock(unit, ledger => store.withLock(unit, async record => {
    if (record.continuity?.goalId !== goalId || ['review','ops'].includes(record.kind)
      || !['SelfGated','InReview','Accepted'].includes(record.state) || record.deliveryPlan || record.deliveryResult || record.sessionFinalization
      || (record.stages ?? []).some(stage => attemptsFor(record,stage.name).some(attempt => !attempt.endedAt)))
      fail('a submitted, undelivered active goal target is required');
    const rows = await ledger.read();
    if (rows.some(row => row.event === 'intent' && !sessionEffectRetired(rows,row)
      && !rows.some(done => done.event === 'result' && done.seq === row.seq && done.key === row.key && !['unknown','uncertain'].includes(done.result?.status))))
      fail('reconcile uncertain effects before policy recovery', 'EFFECT_UNCERTAIN');
    let receipt;
    await goals.transaction(goalId, async goal => {
      const previous = goal?.policyRecoveries?.find(item => item.id === request.id);
      if (previous && previous.requestDigest !== requestDigest) fail('recovery ID already binds another request', 'POLICY_RECOVERY_CONFLICT');
      // An exact replay is read-only only while its entire post-recovery goal and original unit still match.
      let original = goal;
      if (previous) {
        original = {...goal,revision:request.expectedRevision,policy:previous.previousPolicy,policyChanges:goal.policyChanges.slice(0,-1)};
        if (previous.hadRecoveries) original.policyRecoveries = goal.policyRecoveries.slice(0,-1);
        else delete original.policyRecoveries;
        if (goal.policyRecoveries.at(-1) !== previous || goal.revision !== request.expectedRevision+1
          || effectArgsDigest(goal.policyChanges.at(-1)) !== previous.supersessionDigest
          || effectArgsDigest(goal.policy) !== previous.restoredPolicyDigest) fail('recovery has been superseded', 'POLICY_RECOVERY_STALE');
      }
      if (!goal || goal.goal.status !== 'active' || goal.goal.remaining[0] !== unit
        || original.revision !== request.expectedRevision || effectArgsDigest(original) !== request.goalDigest
        || record.revision !== request.expectedUnitRevision || effectArgsDigest(record) !== request.unitDigest)
        fail('goal or submitted unit changed', 'POLICY_RECOVERY_STALE');
      const change = original.policyChanges?.at(-1), restored = change?.previous;
      if (!change || change.revision !== request.changeRevision || effectArgsDigest(change) !== request.changeDigest
        || change.recoveryId || !text(change.userInputRef) || change.userInputRef === userInputRef
        || executionPoliciesEqual(original.policy,restored)) fail('latest mistaken policy refresh is unavailable', 'POLICY_RECOVERY_CONFLICT');
      const custody = goalOwner(goal,unit);
      if (custody?.ownership !== 'existing' || custody.policyDigest !== effectArgsDigest(restored)
        || effectArgsDigest(custody.owner) !== effectArgsDigest(owner)) fail('prior execution policy must match existing original custody', 'POLICY_RECOVERY_CONFLICT');
      const reviewsAbsent = async () => {
        if ((goal.reviews ?? []).some(item => item.targetUnit === unit)) fail('reviewer activity prevents policy recovery', 'POLICY_RECOVERY_CONFLICT');
        for (const entry of await readdir(path.join(stateRoot,'units'),{withFileTypes:true})) {
          if (!entry.isDirectory()) continue;
          const candidate = await store.read(entry.name);
          if (candidate?.kind === 'review' && candidate.targetUnit === unit && candidate.continuity?.goalId === goalId)
            fail('review registration prevents policy recovery', 'POLICY_RECOVERY_CONFLICT');
        }
      };
      const inspect = async () => {
        await checkFile(goal.source); await checkFile(request.provenance);
        for (const source of record.canon ?? []) await checkFile({...source,path:path.resolve(cwd,source.path ?? '')});
        const target = await adapters.git.inspectUnit({unit,record});
        if (effectArgsDigest(target ?? null) !== request.targetDigest || target?.head !== record.head || target?.contentFingerprint !== record.contentFingerprint)
          fail('submitted target changed', 'POLICY_RECOVERY_STALE');
        const observation = await adapters.session.observe({cwd:owner.cwd,targetCwd:owner.cwd});
        if (effectArgsDigest(nativeOwner(observation)) !== effectArgsDigest(owner)) fail('native owner changed', 'SESSION_OWNER_MISMATCH');
        await reviewsAbsent();
        return {target,observation};
      };
      const {target,observation} = await inspect();
      const binding = {goalId,unit,userInputRef,argsDigest:requestDigest,goalDigest:request.goalDigest,unitDigest:request.unitDigest,
        targetDigest:request.targetDigest,changeDigest:request.changeDigest,ownerDigest:effectArgsDigest(owner),custodyDigest:effectArgsDigest(custody),
        sourceDigest:goal.source.digest,provenanceDigest:request.provenance.digest,restoredPolicyDigest:effectArgsDigest(restored),
        rejectedPolicyDigest:effectArgsDigest(original.policy),rejectedUserInputRef:change.userInputRef};
      await verifyApprovalInput(adapters.provider,{...binding,effect:'goal.policy.recover',reason:request.reason});
      // The trusted host reads the actual original human message and native account/settings. Presence alone is insufficient.
      const proof = await adapters.provider.verifyPolicyRefreshRecovery({...binding,request:structuredClone(request),goal:structuredClone(original),
        record:structuredClone(record),target:structuredClone(target),observation:structuredClone(observation),custody:structuredClone(custody),change:structuredClone(change)});
      if (proof?.verified !== true || Object.entries(binding).some(([key,value]) => proof[key] !== value)
        || proof.originalAuthority !== true || proof.currentPolicyUnauthorized !== true || proof.priorPolicyAuthorized !== true
        || proof.nativeExecutionVerified !== true || proof.evidenceDigest !== request.provenance.digest)
        fail('original authority and authorized prior native execution policy are unproven', 'POLICY_RECOVERY_UNPROVEN');
      await inspect();
      if (previous) { receipt = {...previous,duplicate:true}; return goal; }
      const supersession = {revision:goal.revision+1,previous:structuredClone(goal.policy),reason:request.reason,userInputRef,
        recoveryId:request.id,supersedesRevision:change.revision};
      receipt = {id:request.id,request:structuredClone(request),userInputRef,requestDigest,revision:goal.revision+1,
        previousPolicy:structuredClone(goal.policy),restoredPolicyDigest:binding.restoredPolicyDigest,supersessionDigest:effectArgsDigest(supersession),
        hadRecoveries:Object.hasOwn(goal,'policyRecoveries'),proof:structuredClone(proof)};
      return {...goal,revision:goal.revision+1,policy:structuredClone(restored),policyChanges:[...goal.policyChanges,supersession],
        policyRecoveries:[...(goal.policyRecoveries ?? []),receipt]};
    });
    return receipt;
  }));
}
