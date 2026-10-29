const classes = new Set(['product', 'harness', 'environment', 'user-domain', 'unknown']);
const sessionBoundaryCauses = new Set(['session-ended', 'context-compressed', 'clear']);

export function classifySessionBoundary(event) {
  if (!event || event.kind !== 'session-boundary' || !sessionBoundaryCauses.has(event.cause)) return null;
  return { kind: 'session-boundary', cause: event.cause };
}

function normalizePart(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim().replaceAll('\\', '/').replace(/\s+/g, ' ');
}

export function createCauseKey({ failurePoint, reason }) {
  const point = normalizePart(failurePoint, 'failurePoint');
  const summary = normalizePart(reason, 'reason');
  return `${point}|${summary}`;
}

export function classifyFailure(failure, previousClass = 'unknown') {
  if (!classes.has(previousClass)) throw new TypeError(`invalid previous failure class: ${previousClass}`);
  if (previousClass !== 'unknown') return previousClass;
  return classes.has(failure?.class) ? failure.class : 'unknown';
}

function causeWithDefaults(cause, causeKey, failureClass) {
  if (cause && cause.causeKey !== causeKey) throw new TypeError('cause key mismatch');
  return {
    causeKey,
    class: failureClass,
    occurrences: cause?.occurrences ?? 0,
    retries: cause?.retries ?? 0,
    resolverAttempts: cause?.resolverAttempts ?? 0,
    activeResolver: cause?.activeResolver ?? false,
  };
}

export function decideFailure({
  failure,
  cause,
  retryLimit = 2,
  resolverLimit = 2,
  needsDiagnosis = false,
  resolverDepth = 0,
} = {}) {
  const causeKey = createCauseKey(failure ?? {});
  if (!Number.isInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) throw new RangeError('retryLimit must be 1..5');
  if (!Number.isInteger(resolverLimit) || resolverLimit < 1 || resolverLimit > 5) throw new RangeError('resolverLimit must be 1..5');
  const failureClass = classifyFailure(failure, cause?.class ?? 'unknown');
  const next = causeWithDefaults(cause, causeKey, failureClass);
  next.occurrences += 1;

  if (failureClass === 'product') {
    if (next.retries >= retryLimit) return { action: 'stop', cause: next, signature: `${failureClass}|${causeKey}` };
    if (needsDiagnosis || (next.occurrences > 1 && retryLimit > 1 && next.retries > 0)) {
      return { action: 'diagnose', cause: next, signature: `${failureClass}|${causeKey}` };
    }
    next.retries += 1;
    return { action: 'retry', cause: next, signature: `${failureClass}|${causeKey}` };
  }

  if (failureClass === 'harness') {
    if (resolverDepth > 0 || next.activeResolver || next.resolverAttempts >= resolverLimit) {
      return { action: 'stop', cause: next, signature: `${failureClass}|${causeKey}` };
    }
    next.resolverAttempts += 1;
    next.activeResolver = true;
    return { action: 'resolver', cause: next, signature: `${failureClass}|${causeKey}` };
  }
  if (failureClass === 'environment') return { action: 'resume', cause: next, signature: `${failureClass}|${causeKey}` };
  if (failureClass === 'user-domain') return { action: 'defer', cause: next, signature: `${failureClass}|${causeKey}` };
  return { action: 'diagnose', cause: next, signature: `${failureClass}|${causeKey}` };
}

export function reserveRetry(cause, limit = 2) {
  if (!cause || !Number.isInteger(cause.retries) || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new TypeError('cause with retry count and a valid limit are required');
  }
  if (cause.retries >= limit) return { action: 'stop', cause: { ...cause } };
  return { action: 'retry', cause: { ...cause, retries: cause.retries + 1 } };
}

export function finishResolver(cause) {
  if (!cause || cause.activeResolver !== true) throw new TypeError('no active resolver reservation');
  return { ...cause, activeResolver: false };
}
import { transitionRecord } from './unit-state.mjs';


export function transitionForFailure(record, decision) {
  if (!record || !decision || typeof decision.action !== 'string') throw new TypeError('record and failure decision are required');
  if (decision.action === 'defer') return transitionRecord(record, 'Stopped');
  if (decision.action === 'resolver' || decision.action === 'resume') return transitionRecord(record, 'Blocked');
  if (decision.action === 'stop') return transitionRecord(record, 'Stopped');
  if (decision.action === 'retry' && record.state !== 'Implementing') return transitionRecord(record, 'Implementing');
  return record;
}

export function resumeFailure(record) {
  if (!record || !['Blocked', 'Stopped'].includes(record.state)) throw new TypeError('unit is not blocked or stopped');
  const origin = record.state === 'Blocked' ? record.blockedFrom : record.stoppedFrom;
  if (!origin) throw new TypeError('blocked or stopped unit has no recorded origin');
  return transitionRecord(record, origin);
}
