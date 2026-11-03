import { readFile } from 'node:fs/promises';
import path from 'node:path';

const { FORGE_CONTINUITY_ROOT: root, FORGE_CONTINUITY_GOAL: goalId, FORGE_CONTINUITY_UNIT: unit } = process.env;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || '{}');
let output = {};
if (root && id(goalId) && id(unit) && path.isAbsolute(root)) {
  let goal, record;
  try {
    [goal, record] = await Promise.all([
      readFile(path.join(root, 'goals', goalId, 'goal.json'), 'utf8').then(JSON.parse),
      readFile(path.join(root, 'units', unit, 'unit.json'), 'utf8').then(JSON.parse),
    ]);
  } catch {}
  const transferred = record?.sessionFinalization?.closeReceipt || (record?.state === 'Closed' && record?.kind !== 'review');
  if (!transferred) {
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
