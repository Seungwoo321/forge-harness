import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';

const invalid = message => Object.assign(new Error(message), { code: 'SCOPE_AMEND_INVALID' });

// An approved scope correction adds product-relative paths to a unit that is not yet accepted. Acceptance criteria are
// unchanged; the previous scopePaths and the verified user authorization are recorded. Out-of-scope findings are then
// resolved through the ordinary scope recheck, never by this command.
export async function amendScope({ store, unit, request, userInputRef, adapters }) {
  const add = Array.isArray(request?.add) ? request.add : null;
  if (!Number.isSafeInteger(request?.expectedRevision) || typeof request?.reason !== 'string' || !request.reason.trim()
    || !add?.length || typeof userInputRef !== 'string' || !userInputRef.trim()) throw invalid('scope amend requires expectedRevision, add paths, reason and user authorization');
  for (const item of add) {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0') || item.includes('\\') || item.startsWith('/')
      || item.split('/').some(part => part === '..' || part === '.')) throw invalid(`scope path must be product-relative: ${item}`);
  }
  const before = await store.read(unit);
  if (!before) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  if (!['Implementing', 'SelfGated', 'InReview'].includes(before.state) || ['review', 'ops'].includes(before.kind) || before.accepted)
    throw Object.assign(new Error('scope amend requires an unaccepted change unit'), { code: 'INVALID_TRANSITION' });
  if (before.revision !== request.expectedRevision) throw Object.assign(new Error('unit changed since the scope amend was requested'), { code: 'STAGE_STALE' });
  const added = [...new Set(add)].filter(item => !(before.scopePaths ?? []).includes(item)).sort();
  if (!added.length) return { unit, added: [], scopePaths: before.scopePaths ?? [] };
  await verifyApprovalInput(adapters.provider, { unit, userInputRef, effect: 'unit.scope.amend',
    argsDigest: effectArgsDigest({ expectedRevision: request.expectedRevision, add: added, reason: request.reason }), reason: request.reason });
  let result;
  await store.update(unit, record => {
    if (record.revision !== request.expectedRevision || record.accepted) throw Object.assign(new Error('unit changed during scope amend'), { code: 'STAGE_STALE' });
    const scopePaths = [...(record.scopePaths ?? []), ...added];
    result = { unit, added, scopePaths };
    return { ...record, scopePaths, scopeAmendments: [...(record.scopeAmendments ?? []), { previous: record.scopePaths ?? [], added, reason: request.reason, userInputRef, at: adapters.now() }] };
  });
  return result;
}

// Reattest the same scope from original human authority; the rejected receipt stays unchanged.
export async function correctScopeApproval({ stateRoot, store, unit, request, userInputRef, adapters }) {
  if (!request || Object.keys(request).sort().join(',') !== 'amendment,expectedRevision,id,reason'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || Object.keys(request.amendment ?? {}).sort().join(',') !== 'digest,index'
    || !Number.isSafeInteger(request.amendment.index) || request.amendment.index < 0
    || !/^sha256:[a-f0-9]{64}$/.test(request.amendment.digest ?? '')
    || typeof request.reason !== 'string' || !request.reason.trim()
    || typeof userInputRef !== 'string' || !userInputRef.trim()) throw invalid('exact amendment, revision, reason and original human input are required');
  if (typeof adapters.git?.inspectUnit !== 'function') throw Object.assign(new Error('live target inspection is required'),{code:'ADAPTER_MISSING'});
  const requestDigest = effectArgsDigest({request,userInputRef}), duplicate = new Error('scope approval already corrected');
  let receipt;
  try {
    await createLedgerStore(stateRoot).withLock(unit, async ledger => {
      const rows = await ledger.read();
      await store.update(unit, async record => {
        const previous = (record.scopeApprovalCorrections ?? []).find(item => item.id === request.id);
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw invalid('correction id binds another request');
          receipt = {...previous,duplicate:true}; throw duplicate;
        }
        if (record.revision !== request.expectedRevision || !['Implementing','SelfGated','InReview'].includes(record.state)
          || ['review','ops'].includes(record.kind) || record.accepted || record.deliveryPlan || record.deliveryResult || record.sessionFinalization)
          throw Object.assign(new Error('correction requires the current unaccepted, undelivered change unit'),{code:'STAGE_STALE'});
        const original = record.scopeAmendments?.[request.amendment.index];
        if (!original || effectArgsDigest(original) !== request.amendment.digest || original.userInputRef === userInputRef
          || (record.scopeApprovalCorrections ?? []).some(item => item.request.amendment.index === request.amendment.index)
          || !original.added?.every(file => record.scopePaths?.includes(file))) throw invalid('original amendment or approval changed');
        if (rows.some(row => row.event === 'intent' && !sessionEffectRetired(rows,row)
          && !rows.some(done => done.event === 'result' && done.seq === row.seq && done.key === row.key
            && !['unknown','uncertain'].includes(done.result?.status)))) throw Object.assign(new Error('reconcile uncertain effects first'),{code:'EFFECT_UNCERTAIN'});
        const target = await adapters.git.inspectUnit({unit,record});
        if (!target?.head || !target.contentFingerprint) throw invalid('current target is unavailable');
        const targetDigest = effectArgsDigest(target);
        await verifyApprovalInput(adapters.provider,{unit,userInputRef,effect:'unit.scope.approval.correct',argsDigest:requestDigest,
          unitDigest:effectArgsDigest(record),amendmentDigest:request.amendment.digest,previousUserInputRef:original.userInputRef,
          targetDigest,reason:request.reason});
        if (effectArgsDigest(await adapters.git.inspectUnit({unit,record})) !== targetDigest)
          throw Object.assign(new Error('target changed during approval verification'),{code:'STAGE_STALE'});
        receipt = {id:request.id,request:structuredClone(request),requestDigest,userInputRef,original:structuredClone(original),
          targetDigest,revision:record.revision+1,correctedAt:adapters.now()};
        return {...record,scopeApprovalCorrections:[...(record.scopeApprovalCorrections ?? []),receipt]};
      });
    });
  } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
