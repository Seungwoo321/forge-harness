import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { effectArgsDigest } from './lib/approvals.mjs';
import { goalOwner, nativeOwner } from './lib/continuity-custody.mjs';
import { prepareEffect } from './lib/policy.mjs';
import { sessionEffectRetired } from './lib/ledger.mjs';
import { taskDigest, taskPackets } from './lib/session-task.mjs';

const { FORGE_CONTINUITY_ROOT: root, FORGE_CONTINUITY_GOAL: goalId, FORGE_CONTINUITY_UNIT: unit } = process.env;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || '{}');
let output = {};
const sameOwner = (a, b) => ['sessionId', 'incarnationId', 'cwd'].every(key => a?.[key] && a[key] === b?.[key]);
async function incomingReview(goal, currentUnit) {
  const custody = goalOwner(goal, currentUnit);
  if (!custody) return false;
  for (const review of (goal.reviews ?? []).filter(item => item.targetUnit === currentUnit && id(item.unit))) {
    try {
      const candidate = JSON.parse(await readFile(path.join(root, 'units', review.unit, 'unit.json'), 'utf8'));
      const plan = candidate.sessionFinalization;
      if (candidate.kind !== 'review' || candidate.state !== 'Closed' || candidate.targetUnit !== currentUnit
        || candidate.continuity?.goalId !== goalId || !plan || plan.mode !== 'review' || plan.closeReceipt
        || !sameOwner(plan.owner, review) || !sameOwner(plan.recipient, custody)) continue;
      const {deliveryReceipt, ownerRetained, closeReceipt, ...stable} = plan;
      const args = {...stable, cwd:plan.recipient.cwd, session:plan.recipient.sessionId, incarnation:plan.recipient.incarnationId};
      const key = prepareEffect('session.deliver', args).key;
      const rows = (await readFile(path.join(root, 'units', review.unit, 'ledger.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const intent = rows.findLast(row => row.event === 'intent' && row.effect === 'session.deliver' && row.key === key);
      if (!intent || effectArgsDigest(intent.args) !== effectArgsDigest(args) || sessionEffectRetired(rows, intent)
        || rows.some(row => row.seq === intent.seq && row.key === key && row.event === 'result')) continue;
      const boundaries = rows.filter(row => row.seq === intent.seq && row.key === key);
      const submitted = boundaries.filter(row => row.event === 'submission'), confirmed = boundaries.filter(row => row.event === 'confirmation');
      if (submitted.length !== 1 || confirmed.length !== 1 || rows.indexOf(submitted[0]) > rows.indexOf(confirmed[0])) continue;
      const binding = submitted[0].binding, recipient = plan.recipient;
      if (!binding?.threadId || recipient.worker?.threadId && recipient.worker.threadId !== binding.threadId) continue;
      const packets = (await taskPackets(plan)).map(({path,digest}) => ({path,digest}));
      const expected = {runtime:recipient.runtime,sessionId:recipient.sessionId,incarnationId:recipient.incarnationId,cwd:recipient.cwd,
        executable:recipient.executable,pid:recipient.pid,threadId:binding.threadId,
        promptDigest:taskDigest(`Read ${plan.resultPath} (${plan.resultDigest}); follow its referenced handoffs. [delivery ${key}]`),
        goalDigest:plan.goalDigest,packets,route:'codex-native-queue/1'};
      if (effectArgsDigest(binding) === effectArgsDigest(expected) && effectArgsDigest(confirmed[0].binding) === effectArgsDigest(binding)) return true;
    } catch {}
  }
  return false;
}
if (root && id(goalId) && id(unit) && path.isAbsolute(root)) {
  let goal, record;
  try {
    [goal, record] = await Promise.all([
      readFile(path.join(root, 'goals', goalId, 'goal.json'), 'utf8').then(JSON.parse),
      readFile(path.join(root, 'units', unit, 'unit.json'), 'utf8').then(JSON.parse),
    ]);
  } catch {}
  const visited = new Set([unit]);
  let currentUnit = unit;
  while (goal && record) {
    const transfer = goal.transfers?.find(item => item.unit === currentUnit);
    if (!transfer || transfer.sameSession !== true && transfer.deliveredContinuation !== true) break;
    if (!id(transfer.successor) || visited.has(transfer.successor)) { record = null; break; }
    try {
      const next = JSON.parse(await readFile(path.join(root, 'units', transfer.successor, 'unit.json'), 'utf8'));
      if (transfer.deliveredContinuation === true) {
        const adoption = goalOwner(goal, transfer.successor);
        if (record.state !== 'Delivered' || effectArgsDigest(record) !== transfer.unitDigest
          || adoption?.ownership !== 'existing' || adoption.requestDigest !== transfer.requestDigest
          || next.continuity?.goalId !== goalId
          || effectArgsDigest(nativeOwner(record.sessionFinalization?.owner)) !== effectArgsDigest(adoption.owner)) throw new Error('retained continuation differs');
      }
      currentUnit = transfer.successor;
      visited.add(currentUnit);
      record = next;
    } catch { record = null; }
  }
  const transferred = record?.sessionFinalization?.closeReceipt
    || (record?.state === 'Closed' && record?.kind !== 'review' && goal?.goal?.status === 'complete');
  if (!transferred && goal && record && goal.goal?.status === 'active' && goal.goal.remaining?.[0] === currentUnit
    && await incomingReview(goal, currentUnit)) {
    output = {systemMessage:'An existing queued review return is pending for this owner. Yield this turn so the native dispatcher can receive that original request; keep the goal active and verify its real receipt and reviewer closure. Do not resubmit input or finish the predecessor.'};
  } else if (!transferred) {
    const action = !goal || !record ? 'Inspect the goal and unit state; do not infer completion from a missing record.'
      : record.kind === 'review' && record.state === 'Closed' ? 'Use the session-return skill to transfer the review and verify closure.'
      : goal.goal?.status === 'blocked' || record.state === 'Stopped' ? 'Use the session-stop skill to record the blocker, transfer context and verify closure.'
      : record.state === 'Delivered' ? 'Use the session-finish skill to reconcile the existing handoff and finalizer.'
      : 'Continue the authorized goal. When the unit finishes use the session-finish skill; for an actual blocker use the session-stop skill.';
    const reason = `${action} Honor an explicit user pause, decision or external blocker; do not invent completion or start a duplicate session.`;
    output = event.stop_hook_active ? {systemMessage:`Goal handoff remains unresolved. ${reason}`} : {decision:'block',reason};
  }
}
process.stdout.write(`${JSON.stringify(output)}\n`);
