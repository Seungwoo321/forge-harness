import { createHash } from 'node:crypto';
import { prepareEffect } from './policy.mjs';
import { validateAcceptedContent } from './delivery.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function effectArgsDigest(args) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(args))).digest('hex')}`;
}

export async function verifyApprovalInput(provider, input) {
  if (typeof provider?.verifyUserInput !== 'function') {
    throw Object.assign(new Error('a trusted user-input verifier is required'), { code: 'EFFECT_APPROVAL_REQUIRED' });
  }
  const verified = await provider.verifyUserInput(input);
  if (verified?.verified !== true || Object.entries(input).some(([key, value]) => verified[key] !== value)) {
    throw Object.assign(new Error('user input does not authorize the exact effect request'), { code: 'EFFECT_APPROVAL_REQUIRED' });
  }
}

export async function recordApproval({ store, unit, request, userInputRef, adapters }) {
  prepareEffect(request?.effect, request?.args);
  if (typeof userInputRef !== 'string' || !userInputRef || typeof request?.reason !== 'string' || !request.reason.trim()) {
    throw Object.assign(new Error('approval requires a user-input reference and reason'), { code: 'EFFECT_APPROVAL_REQUIRED' });
  }
  let approval;
  await store.update(unit, async record => {
    if (!['Accepted', 'Delivering'].includes(record.state) || !record.accepted?.head) {
      throw Object.assign(new Error('approval requires an accepted target before delivery completes'), { code: 'INVALID_TRANSITION' });
    }
    const target = await adapters.git?.inspectUnit({ unit, record });
    if (!validateAcceptedContent(record.accepted, target).valid) {
      throw Object.assign(new Error('approval target no longer matches acceptance'), { code: 'EFFECT_APPROVAL_REQUIRED' });
    }
    const input = { unit, userInputRef, effect: request.effect, argsDigest: effectArgsDigest(request.args), head: record.accepted.head, reason: request.reason };
    await verifyApprovalInput(adapters.provider, input);
    const checked = await adapters.git.inspectUnit({ unit, record });
    if (!validateAcceptedContent(record.accepted, checked).valid) {
      throw Object.assign(new Error('approval target changed during user-input verification'), { code: 'EFFECT_APPROVAL_REQUIRED' });
    }
    approval = { id: adapters.id(), effect: input.effect, argsDigest: input.argsDigest, head: input.head,
      reason: input.reason, userInputRef, approvedAt: adapters.now() };
    return { ...record, approvals: [...(record.approvals ?? []), approval] };
  });
  return approval;
}

export async function resolveEffectApproval({ record, effect, args, approvalRef, provider }) {
  const approval = (record.approvals ?? []).find(item => item.id === approvalRef);
  const argsDigest = effectArgsDigest(args);
  if (!approval || approval.effect !== effect || approval.argsDigest !== argsDigest
    || approval.head !== record.accepted?.head || typeof approval.userInputRef !== 'string' || !approval.userInputRef
    || typeof approval.reason !== 'string' || !approval.reason
    || typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw Object.assign(new Error('an exact stored approval is required'), { code: 'EFFECT_APPROVAL_REQUIRED' });
  }
  await verifyApprovalInput(provider, { unit: record.unit, userInputRef: approval.userInputRef,
    effect, argsDigest, head: approval.head, reason: approval.reason });
  return approval;
}
