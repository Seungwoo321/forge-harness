import path from 'node:path';

const nonempty = value => typeof value === 'string' && value.trim() && !value.includes('\0');
const id = value => nonempty(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
const fail = message => { throw Object.assign(new TypeError(message), { code: 'CONTINUITY_INVALID' }); };

export function validateGoal(goal) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal) || !id(goal.id) || !nonempty(goal.objective)
    || !Array.isArray(goal.criteria) || !goal.criteria.length || goal.criteria.some(item => !nonempty(item)) || new Set(goal.criteria).size !== goal.criteria.length) fail('goal requires an id, objective and completion criteria');
  if (!Array.isArray(goal.remaining) || goal.remaining.some(item => !id(item)) || new Set(goal.remaining).size !== goal.remaining.length) fail('goal remaining work must contain distinct unit ids');
  if (!['active', 'blocked', 'complete'].includes(goal.status)) fail('invalid goal status');
  if (goal.status === 'complete' && goal.remaining.length) fail('an unfinished goal cannot be complete');
  if (goal.status === 'blocked' && (!id(goal.blocker?.unit) || !goal.remaining.includes(goal.blocker.unit) || !nonempty(goal.blocker?.reason) || !nonempty(goal.blocker?.resumeCondition) || !nonempty(goal.blocker?.evidence))) fail('blocked goal requires a reason and resume condition');
  return goal;
}

export function validateExecutionPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key=>!['runtime','provider','account','model','effort','argv'].includes(key)) || !['cmux', 'orca'].includes(policy.runtime) || !['codex', 'claude'].includes(policy.provider)
    || !nonempty(policy.account) || !nonempty(policy.model) || !nonempty(policy.effort)
    || !path.isAbsolute(policy.account) || !Array.isArray(policy.argv) || !policy.argv.length || policy.argv.some(item => !nonempty(item))
    || path.basename(policy.argv[0]) !== policy.provider || policy.argv.slice(1).some(arg => /^(?:--model(?:=|$)|-m$|--effort(?:=|$)|--session-id(?:=|$)|-c$|--config(?:=|$))/.test(arg))) fail('execution policy requires an explicit provider command and unambiguous account, model and effort');
  return policy;
}

export function selectExecutionPolicy(policy, role) {
  if (!['implementation','review','diagnosis','resolver'].includes(role)) fail('unsupported session role');
  const { roles, ...base } = policy ?? {};
  if (roles !== undefined && (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).some(key=>!['implementation','review','diagnosis','resolver'].includes(key)))) fail('invalid role policy');
  for (const override of Object.values(roles ?? {})) {
    if (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some(key=>!['runtime','provider','account','model','effort','argv'].includes(key))) fail('invalid role policy override');
    validateExecutionPolicy({ ...base, ...override });
  }
  const selected = { ...base, ...(roles?.[role] ?? {}) };
  return validateExecutionPolicy(selected);
}

export function decideContinuity({ goal, unit, successor, goalComplete = false }) {
  validateGoal(goal);
  if (!id(unit)) fail('current unit is invalid');
  if (goal.status === 'blocked') return { kind: 'blocked', blocker: goal.blocker };
  if (goal.status !== 'complete' && goal.remaining[0] !== unit) fail('current unit is not the next outstanding unit');
  const remaining = goal.remaining.filter(item => item !== unit);
  if (goalComplete) {
    if (goal.status !== 'complete' || remaining.length || goal.remaining.length) fail('goal completion is not recorded');
    return { kind: 'complete' };
  }
  if (!successor || successor.approved !== true || !id(successor.unit) || remaining[0] !== successor.unit) fail('unfinished goal requires an approved remaining successor');
  return { kind: 'next', unit: successor.unit };
}

export function composeGoalPrompt({ goal, policy, handoff }) {
  validateGoal(goal); validateExecutionPolicy(policy);
  if (!handoff || !nonempty(handoff.path) || !/^sha256:[a-f0-9]{64}$/.test(handoff.digest ?? '')) fail('immutable handoff reference is required');
  return [
    `Goal: ${goal.objective}`,
    `Completion criteria: ${goal.criteria.join('; ')}`,
    `Remaining units: ${goal.remaining.join(', ') || '(none)'}`,
    `Execution policy: ${policy.runtime}, ${policy.provider}, ${policy.account}, ${policy.model}, ${policy.effort}`,
    // Claude receipts are verified from Read tool results; a shell cat leaves the start unverified.
    `${policy.provider === 'claude' ? 'With the Read tool, read' : 'Read'} ${handoff.path} (${handoff.digest}) and follow its referenced context.`,
    'On unit completion or a blocker, use the session handoff and finish skills; do not declare the overall goal complete while work remains.',
  ].join(' ');
}
