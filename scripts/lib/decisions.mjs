import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { transitionRecord } from './unit-state.mjs';

const decisionKinds = new Set(['preference', 'authority', 'canon-conflict', 'external-access', 'retry-limit']);

function decisionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseEvents(content) {
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(line => {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('decision event log contains an invalid row');
    return event;
  });
}

function eventExists(events, unit, decisionId) {
  return events.find(event => event.kind === 'notification' && event.unit === unit && event.decisionId === decisionId);
}

export function validateDecision(record, decisionId) {
  const decision = (record.openDecisions ?? []).find(item => item.id === decisionId);
  if (!decision) throw decisionError('DECISION_NOT_FOUND', `open decision not found: ${decisionId}`);
  if (!decisionKinds.has(decision.kind)) throw decisionError('DECISION_INVALID', 'open decision kind is not eligible for notification');
  if (typeof decision.question !== 'string' || !decision.question.trim()
    || !Array.isArray(decision.options) || decision.options.some(option => typeof option !== 'string' || !option.trim())
    || (decision.requiredAction != null && (!decision.requiredAction || typeof decision.requiredAction !== 'object'
      || ['stage', 'effect', 'resumeCondition'].some(field => typeof decision.requiredAction[field] !== 'string' || !decision.requiredAction[field].trim())))) {
    throw decisionError('DECISION_INVALID', 'decision question, options, or required action are invalid');
  }
  if (decision.answer != null) throw decisionError('DECISION_RESOLVED', 'resolved decisions cannot be notified');
  if (!Array.isArray(decision.blocks) || decision.blocks.some(id => !(record.acceptance ?? []).some(item => item.id === id))) {
    throw decisionError('DECISION_INVALID', 'decision blocks must identify existing acceptance criteria');
  }
  if (!Array.isArray(record.canon) || !record.canon.length
    || record.canon.some(item => typeof item?.path !== 'string' || !item.path || typeof item.digest !== 'string' || !item.digest)) {
    throw decisionError('DECISION_INVALID', 'unit must identify valid canonical references');
  }
  const canonByPath = new Map(record.canon.map(item => [item.path, item.digest]));
  const refs = [...new Set(decision.canonRefs?.length ? decision.canonRefs : record.canon.map(item => item.path))];
  if (refs.some(ref => !canonByPath.has(ref))) throw decisionError('DECISION_INVALID', 'decision canonical references must belong to the unit');
  return { decision, refs, canonByPath };
}

function assessNotification(record, decisionId, now, events, threshold) {
  const { decision, refs, canonByPath } = validateDecision(record, decisionId);
  const canonDigests = Object.fromEntries(refs.map(ref => [ref, canonByPath.get(ref)]));
  const event = {
    kind: 'notification', unit: record.unit, decisionId, decisionKind: decision.kind,
    canonDigests, notifiedAt: decision.notifiedAt ?? now,
  };
  const prior = eventExists(events, record.unit, decisionId);
  if (prior) return { event: prior, escalation: null, duplicate: true };
  const withCurrent = [...events, event];
  const escalation = refs.map(ref => {
    const digest = canonByPath.get(ref);
    const count = withCurrent.filter(item => item.kind === 'notification' && item.canonDigests?.[ref] === digest).length;
    const alreadyReported = events.some(item => item.kind === 'canon-review' && item.path === ref && item.digest === digest);
    return count >= threshold && !alreadyReported ? { kind: 'canon-review', path: ref, digest, count, threshold, unit: record.unit, decisionId, createdAt: now } : null;
  }).filter(Boolean);
  return { event, escalation: escalation[0] ?? null, duplicate: false };
}

function withNotification(record, event) {
  const decision = record.openDecisions.find(item => item.id === event.decisionId);
  if (decision.notifiedAt) return record;
  const blocks = new Set(decision.blocks);
  let updated = {
    ...record,
    openDecisions: record.openDecisions.map(item => item.id === decision.id ? { ...item, notifiedAt: event.notifiedAt } : item),
    acceptance: record.acceptance.map(item => blocks.has(item.id) ? { ...item, status: 'deferred' } : item),
  };
  const hasAvailableWork = updated.acceptance.some(item => !['deferred', 'dropped'].includes(item.status));
  const blockingDecision = updated.openDecisions.some(item => item.answer == null
    && (item.requiredAction || (item.blocks ?? []).some(id => updated.acceptance.some(ac => ac.id === id && ac.status === 'deferred'))));
  if (!hasAvailableWork && blockingDecision && ['Scoped', 'Implementing'].includes(updated.state)) updated = transitionRecord(updated, 'Stopped');
  return updated;
}

function resolveDecisionRecord(record, decisionId, answer, now) {
  const decision = (record.openDecisions ?? []).find(item => item.id === decisionId);
  if (!decision) throw decisionError('DECISION_NOT_FOUND', `open decision not found: ${decisionId}`);
  if (decision.answer != null) throw decisionError('DECISION_RESOLVED', 'decision already has an answer');
  if (typeof answer !== 'string' || !answer.trim()) throw decisionError('DECISION_INVALID', 'decision answer must be non-empty');
  if (typeof now !== 'string' || !now) throw TypeError('decision answer time is required');
  if (Array.isArray(decision.options) && decision.options.length && !decision.options.includes(answer.trim())) {
    throw decisionError('DECISION_INVALID', 'decision answer must match one of the offered options');
  }
  const blocks = new Set(decision.blocks ?? []);
  let updated = {
    ...record,
    openDecisions: record.openDecisions.map(item => item.id === decisionId ? { ...item, answer: { value: answer.trim(), answeredAt: now } } : item),
    acceptance: record.acceptance.map(item => blocks.has(item.id) && item.status === 'deferred' ? { ...item, status: 'open' } : item),
  };
  const anotherBlocker = updated.openDecisions.some(item => item.answer == null && (item.requiredAction || (item.blocks ?? []).some(id => updated.acceptance.some(ac => ac.id === id && ac.status === 'deferred'))));
  const hasAvailableWork = updated.acceptance.some(item => !['deferred', 'dropped'].includes(item.status));
  if (updated.state === 'Blocked' && !anotherBlocker) updated = transitionRecord(updated, updated.blockedFrom);
  if (updated.state === 'Stopped' && !anotherBlocker && hasAvailableWork) updated = transitionRecord(updated, updated.stoppedFrom);
  return updated;
}

export function createDecisionStore(stateRoot) {
  const root = path.resolve(stateRoot);
  const log = path.join(root, 'escalations.ndjson');
  const lockPath = `${log}.lock`;

  async function withLock(action) {
    await mkdir(root, { recursive: true });
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(lockPath, 'utf8')); }
        catch { throw decisionError('DECISION_LOCK_INVALID', 'decision log lock is unreadable; inspect it before retrying'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw decisionError('DECISION_LOCK_INVALID', 'decision log lock has no valid owner; inspect it before retrying');
        try { process.kill(owner.pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') throw decisionError('DECISION_LOCK_ORPHANED', `decision log lock owner exited: ${owner.pid}`);
          if (probe.code !== 'EPERM') throw probe;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      return await action();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  async function readEvents() {
    try { return parseEvents(await readFile(log, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function append(events) {
    if (!events.length) return;
    await mkdir(root, { recursive: true });
    const file = await open(log, 'a', 0o600);
    try {
      await file.writeFile(events.map(event => `${JSON.stringify(event)}\n`).join(''));
      await file.sync();
    } finally { await file.close(); }
  }

  return Object.freeze({
    async notify({ store, unit, decisionId, now, threshold = 5 }) {
      if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') throw new TypeError('Unit Record store is required');
      if (typeof now !== 'string' || !now) throw new TypeError('notification time is required');
      if (!Number.isSafeInteger(threshold) || threshold < 1) throw new TypeError('canon review threshold must be a positive integer');
      return withLock(async () => {
        const record = await store.read(unit);
        if (!record) throw decisionError('UNIT_NOT_FOUND', `unit not found: ${unit}`);
        const events = await readEvents();
        const prepared = assessNotification(record, decisionId, now, events, threshold);
        if (!prepared.duplicate) await append([prepared.event, ...(prepared.escalation ? [prepared.escalation] : [])]);
        const updated = await store.update(unit, current => withNotification(current, prepared.event));
        return { record: updated, notification: prepared.event, escalation: prepared.escalation, duplicate: prepared.duplicate };
      });
    },

    async resolve({ store, unit, decisionId, answer, now }) {
      if (!store || typeof store.update !== 'function') throw new TypeError('Unit Record store is required');
      return store.update(unit, current => resolveDecisionRecord(current, decisionId, answer, now));
    },

    async events() { return withLock(readEvents); },
  });
}
