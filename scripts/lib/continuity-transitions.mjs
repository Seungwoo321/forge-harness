const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const failure = message => Object.assign(new Error(message), { code: 'CONTINUITY_STALE' });

export function blockGoal(current, { expectedRevision, unit, reason, resumeCondition, evidence }) {
  if (!current || current.revision !== expectedRevision || current.goal.status !== 'active') throw failure('goal is not active at the expected revision');
  if (!nonempty(unit) || current.goal.remaining[0] !== unit || !nonempty(reason) || !nonempty(resumeCondition) || !nonempty(evidence)) throw Object.assign(new TypeError('blocker requires reason, evidence and resume condition'), {code:'CONTINUITY_INVALID'});
  return { ...current, revision: current.revision + 1, goal: { ...current.goal, status:'blocked', blocker:{unit,reason,resumeCondition,evidence} } };
}

export function resumeGoal(current, { expectedRevision, unit, resolutionEvidence }) {
  if (!current || current.revision !== expectedRevision || current.goal.status !== 'blocked') throw failure('goal is not blocked at the expected revision');
  if (unit !== current.goal.blocker?.unit || !nonempty(resolutionEvidence)) throw Object.assign(new TypeError('resume requires resolution evidence'), {code:'CONTINUITY_INVALID'});
  const { blocker, ...goal } = current.goal;
  return { ...current, revision: current.revision + 1, goal: { ...goal, status:'active' },
    blockerHistory:[...(current.blockerHistory ?? []), {...blocker, resolutionEvidence}] };
}

export function appendGoalWork(current, {expectedRevision, units, evidence}) {
  if (!current || current.revision !== expectedRevision || current.goal.status !== 'active') throw failure('goal is not active at the expected revision');
  const used = new Set([...current.goal.remaining, ...(current.transfers ?? []).map(item=>item.unit)]);
  if (!Array.isArray(units) || !units.length || units.some(unit=>typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '.' || unit === '..' || used.has(unit)) || new Set(units).size !== units.length || !nonempty(evidence))
    throw Object.assign(new TypeError('new work must have distinct unused unit ids and decision evidence'), {code:'CONTINUITY_INVALID'});
  return {...current,revision:current.revision+1,goal:{...current.goal,remaining:[...current.goal.remaining,...units]},
    workHistory:[...(current.workHistory ?? []),{units,evidence}]};
}
