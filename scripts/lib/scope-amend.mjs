import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';

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
