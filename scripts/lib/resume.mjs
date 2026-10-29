const validStates = new Set([
  'Scoped', 'Implementing', 'SelfGated', 'InReview', 'Accepted', 'Delivering', 'Delivered', 'Blocked', 'Stopped', 'Closed',
]);

const stageForState = {
  Scoped: 'scope',
  Implementing: 'implement',
  SelfGated: 'gates',
  InReview: 'review',
  Accepted: 'delivery',
  Delivering: 'delivery',
  Delivered: 'handoff',
};

function validateRecord(record) {
  if (!record || record.schema !== 'harness.unit/1' || typeof record.unit !== 'string'
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !validStates.has(record.state)) {
    throw new TypeError('resume requires a valid persisted Unit Record');
  }
  if (record.state === 'Blocked' && !stageForState[record.blockedFrom]) throw new TypeError('blocked unit has no valid origin state');
  if (record.state === 'Stopped' && !stageForState[record.stoppedFrom]) throw new TypeError('stopped unit has no valid origin state');
}

function resumeState(record) {
  if (record.state === 'Blocked') return record.blockedFrom;
  if (record.state === 'Stopped') return record.stoppedFrom;
  return record.state;
}

function pendingEffects(records) {
  const intents = new Map();
  const completed = new Set();
  for (const row of records) {
    if (row?.event === 'intent' && Number.isSafeInteger(row.seq)) intents.set(row.seq, row);
    if (row?.event === 'result' && Number.isSafeInteger(row.seq)) completed.add(row.seq);
  }
  return [...intents.values()].filter(row => !completed.has(row.seq)).sort((a, b) => a.seq - b.seq);
}

function latestAttempts(record) {
  for (let stageIndex = (record.stages?.length ?? 0) - 1; stageIndex >= 0; stageIndex -= 1) {
    const stage = record.stages[stageIndex];
    const attempt = stage.attempts?.at(-1);
    if (attempt) return { stage: stage.name, attempt };
  }
  return null;
}

function latestEvidence(records) {
  const latest = new Map();
  for (const item of records) {
    if (!item || typeof item.gate !== 'string' || !item.gate) throw new TypeError('evidence records require gate IDs');
    latest.set(item.gate, item);
  }
  return [...latest.values()];
}

function decision(action, fields = {}) {
  return { action, ...fields };
}

/**
 * Produces the next resume action from persisted state and explicit adapter snapshots.
 * It never reads conversation, clock, filesystem, Git, or tracker state itself.
 */
export function decideResume({ record, ledger = [], git, evidence = [], currentFingerprints = {}, tracker } = {}) {
  validateRecord(record);
  if (!Array.isArray(ledger) || !Array.isArray(evidence) || !currentFingerprints || typeof currentFingerprints !== 'object') {
    throw new TypeError('resume snapshots are invalid');
  }

  const targetState = resumeState(record);
  const pending = pendingEffects(ledger);
  if (pending.length) {
    return decision('reconcile-effect', { unit: record.unit, seq: pending[0].seq, key: pending[0].key, resumeState: targetState });
  }

  if (!git || typeof git.head !== 'string' || !git.checkpoints || typeof git.checkpoints !== 'object'
    || !Array.isArray(git.worktreeDiff) || !Array.isArray(git.indexDiff)) {
    return decision('inspect-git', { unit: record.unit, resumeState: targetState, reason: 'git snapshot is incomplete' });
  }

  const latest = latestAttempts(record);
  if (latest?.attempt.checkpoint && !Object.hasOwn(git.checkpoints, latest.attempt.checkpoint)) {
    return decision('inspect-git', { unit: record.unit, resumeState: targetState, checkpoint: latest.attempt.checkpoint, reason: 'checkpoint status is unknown' });
  }

  if (record.accepted && (
    git.head !== record.accepted.head
    || (git.contentFingerprint !== undefined && git.contentFingerprint !== record.accepted.contentFingerprint)
    || git.worktreeDiff.length > 0 || git.indexDiff.length > 0
  )) {
    return decision('revalidate', { unit: record.unit, fromState: record.state, resumeState: targetState, nextStage: 'gates', reason: 'accepted content changed' });
  }

  for (const item of latestEvidence(evidence)) {
    if (!Object.hasOwn(currentFingerprints, item.gate)) {
      return decision('inspect-evidence', { unit: record.unit, gate: item.gate, resumeState: targetState, reason: 'current fingerprint is unavailable' });
    }
    if (item.fingerprint !== currentFingerprints[item.gate] || item.exit !== 0 || item.failureClass != null || item.nondeterministic === true) {
      return decision('rerun-gate', { unit: record.unit, gate: item.gate, resumeState: targetState, reason: item.fingerprint !== currentFingerprints[item.gate] ? 'evidence fingerprint changed' : 'latest evidence did not pass' });
    }
  }

  if (record.tracker) {
    if (!tracker || typeof tracker.state !== 'string' || !Number.isSafeInteger(tracker.revision)) {
      return decision('inspect-tracker', { unit: record.unit, resumeState: targetState, reason: 'tracker projection status is unknown' });
    }
    if (tracker.state !== record.state || tracker.revision !== record.revision) {
      return decision('project-tracker', { unit: record.unit, resumeState: targetState, revision: record.revision });
    }
  }

  if (record.state === 'Closed') return decision('complete', { unit: record.unit, state: 'Closed' });
  const state = targetState;
  return decision('resume', {
    unit: record.unit,
    state,
    stage: stageForState[state],
    worktreeDiff: [...git.worktreeDiff],
    indexDiff: [...git.indexDiff],
  });
}
