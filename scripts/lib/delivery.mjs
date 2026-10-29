const levels = ['none', 'commit', 'push', 'pr', 'merge'];

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rank(level) {
  const value = levels.indexOf(level);
  if (value < 0) throw new TypeError(`invalid delivery level: ${level}`);
  return value;
}

export function authorizeDelivery(policy, requested) {
  const maximum = policy?.delivery ?? 'none';
  if (rank(requested) > rank(maximum)) {
    throw errorWithCode('DELIVERY_DENIED', `requested ${requested} exceeds policy delivery ${maximum}`);
  }
  return { level: requested };
}

export function validateAcceptedContent(accepted, current) {
  if (!accepted || typeof accepted.head !== 'string' || !accepted.head
    || typeof accepted.contentFingerprint !== 'string' || !accepted.contentFingerprint) {
    throw errorWithCode('ACCEPTANCE_MISSING', 'delivery requires an accepted head and content fingerprint');
  }
  if (current?.contentFingerprint !== accepted.contentFingerprint) {
    return { valid: false, nextState: 'SelfGated', reason: 'accepted content fingerprint changed' };
  }
  if (current.head !== accepted.head) {
    return { valid: false, nextState: 'SelfGated', reason: 'accepted unit head changed' };
  }
  for (const field of ['repo', 'branch', 'tree', 'indexTree', 'base']) {
    if (accepted[field] !== undefined && current[field] !== accepted[field]) {
      return { valid: false, nextState: 'SelfGated', reason: `accepted ${field} changed` };
    }
  }
  return { valid: true, nextState: null };
}

export function bindDeliveryCommit(accepted, current, commit) {
  const check = validateAcceptedContent(accepted, current);
  if (!check.valid) return check;
  if (commit?.parent !== accepted.head) {
    throw errorWithCode('DELIVERY_HEAD_MISMATCH', 'delivery commit must descend directly from the accepted head');
  }
  if (commit?.contentFingerprint !== accepted.contentFingerprint) {
    return { valid: false, nextState: 'SelfGated', reason: 'delivery commit content differs from accepted content' };
  }
  if (typeof commit.sha !== 'string' || !commit.sha || typeof commit.tree !== 'string' || !commit.tree) {
    throw new TypeError('delivery commit requires sha and tree');
  }
  return {
    valid: true,
    accepted: {
      ...accepted,
      validatedHead: accepted.validatedHead ?? accepted.head,
      head: commit.sha,
    },
    binding: { beforeHead: accepted.head, afterHead: commit.sha, tree: commit.tree },
  };
}

export function bindMergeResult(accepted, current, result) {
  const check = validateAcceptedContent(accepted, current);
  if (!check.valid) return check;
  if (result?.acceptedHead !== accepted.head) {
    throw errorWithCode('DELIVERY_HEAD_MISMATCH', 'merge must use the head fixed by acceptance');
  }
  if (typeof result.mergeHead !== 'string' || !result.mergeHead) throw new TypeError('merge result requires mergeHead');
  return {
    valid: true,
    accepted,
    deliveryResult: {
      level: 'merge',
      head: accepted.head,
      mergeHead: result.mergeHead,
      effectRefs: result.effectRefs ?? [],
    },
  };
}

export { levels as deliveryLevels };
