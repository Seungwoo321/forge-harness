import { validateAcceptedContent } from './delivery.mjs';
import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { transitionRecord } from './unit-state.mjs';

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createProjectionQueue(stateRoot, adapters) {
  const file = path.join(path.resolve(stateRoot), 'projection-queue.ndjson');
  const lockFile = `${file}.lock`;
  async function withLock(action) {
    await mkdir(path.dirname(file), { recursive: true });
    let lock;
    while (!lock) {
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(lockFile, 'utf8')); }
        catch { throw errorWithCode('PROJECTION_LOCK_INVALID', 'projection queue lock is unreadable; inspect it before retrying'); }
        const pid = owner?.pid;
        if (!Number.isSafeInteger(pid) || pid < 1) throw errorWithCode('PROJECTION_LOCK_INVALID', 'projection queue lock has no valid owner; inspect it before retrying');
        try { process.kill(pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') throw errorWithCode('PROJECTION_LOCK_ORPHANED', `projection queue lock owner exited: ${pid}`);
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
      await rm(lockFile, { force: true });
    }
  }
  async function rows() {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return Object.freeze({
    async enqueue({ unit, tracker, projection, terminal = false, error }) {
      return withLock(async () => {
        const entries = await rows();
        const previous = entries.findLast(item => item.event === 'queued' && item.unit === unit && item.projection.revision === projection.revision);
        if (previous && !entries.some(item => item.event === 'projected' && item.id === previous.id)) return previous;
        const entry = {
          event: 'queued', id: adapters.id(), unit, tracker, projection, terminal,
          queuedAt: adapters.now(), error: String(error?.message ?? error ?? 'projection failed'),
        };
        await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
        return entry;
      });
    },
    async pending() {
      const entries = await rows();
      const latest = new Map();
      for (const entry of entries) latest.set(entry.id, entry);
      return [...latest.values()].filter(item => item.event === 'queued');
    },
    async projected(entry) {
      return withLock(async () => {
        const entries = await rows();
        if (entries.some(item => item.event === 'projected' && item.id === entry.id)) return;
        await appendFile(file, `${JSON.stringify({ event: 'projected', id: entry.id, projectedAt: adapters.now() })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
      });
    },
  });
}

export async function projectUnit(record, adapter, queue) {
  if (!record.tracker) return { status: 'skipped', reason: 'no tracker configured' };
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.project !== 'function') {
    const error = errorWithCode('ADAPTER_MISSING', 'tracker adapter must implement read and project');
    const queued = await queue.enqueue({ unit: record.unit, tracker: record.tracker, projection: { unit: record.unit, state: record.state, revision: record.revision }, error });
    return { status: 'queued', revision: record.revision, queueId: queued.id };
  }
  const projection = { unit: record.unit, state: record.state, revision: record.revision };
  try {
    const observed = await adapter.read(record.tracker.ref);
    if (observed?.state === projection.state && observed?.revision === projection.revision) return { status: 'current', revision: projection.revision };
    await adapter.project(record.tracker.ref, projection);
    return { status: 'projected', revision: projection.revision };
  } catch (error) {
    if (!queue || typeof queue.enqueue !== 'function') throw errorWithCode('ADAPTER_MISSING', 'projection queue is unavailable');
    const queued = await queue.enqueue({ unit: record.unit, tracker: record.tracker, projection, error });
    return { status: 'queued', revision: projection.revision, queueId: queued.id };
  }
}

async function revalidateTerminalTarget({ store, unit, git }) {
  const record = await store.read(unit);
  if (!record?.accepted || record.state !== 'Delivered') return record;
  if (typeof git?.inspectUnit !== 'function') throw errorWithCode('ADAPTER_MISSING', 'terminal completion requires Git inspection');
  return store.update(unit, async current => {
    if (!current.accepted || current.state !== 'Delivered') return current;
    const checked = validateAcceptedContent(current.accepted, await git.inspectUnit({ unit, record: current }));
    return checked.valid ? current : transitionRecord({ ...current, accepted: null, reviewDecision: null }, 'SelfGated');
  });
}

export async function projectTerminalUnit({ store, unit, adapter, queue, now, git }) {
  let record = await revalidateTerminalTarget({ store, unit, git });
  if (!record) throw errorWithCode('UNIT_NOT_FOUND', `unit not found: ${unit}`);
  if (record.state !== 'Delivered') throw errorWithCode('INVALID_TRANSITION', 'only Delivered units can close');
  if ((record.acceptance ?? []).some(item => item.status === 'deferred')) throw errorWithCode('DEFERRED_ACCEPTANCE', 'deferred acceptance criteria prevent close');
  if ((record.openDecisions ?? []).some(item => !item.answer)) throw errorWithCode('OPEN_DECISIONS', 'open decisions prevent close');
  if (!record.tracker) return { projected: true, record };
  const requested = record.terminalProjection;
  if (!requested) {
    record = await store.update(unit, current => ({ ...current, terminalProjection: {
      revision: current.revision + 2,
      requestedAt: now(),
    }, tracker: { ...current.tracker, projected: false } }));
  }
  const projection = { unit, state: 'Closed', revision: record.terminalProjection.revision };
  try {
    const observed = await adapter.read(record.tracker.ref);
    if (observed?.state !== projection.state || observed?.revision !== projection.revision) await adapter.project(record.tracker.ref, projection);
  } catch (error) {
    await queue.enqueue({ unit, tracker: record.tracker, projection, terminal: true, error });
    return { projected: false, record, closePending: true };
  }
  return { projected: true, record };
}

export async function commitTerminalClose({ store, unit, git, sessionStart }) {
  const record = await revalidateTerminalTarget({ store, unit, git });
  if (record?.state === 'SelfGated') return record;
  return await store.update(unit, current => {
    if (current.state !== 'Delivered') throw errorWithCode('INVALID_TRANSITION', 'terminal close requires a Delivered unit');
    if (current.next?.handoff && (!['completed', 'duplicate', 'reconciled'].includes(sessionStart?.status) || !sessionStart.result?.sessionId)) throw errorWithCode('SUCCESSOR_PENDING', 'successor start must be confirmed before close');
    if ((current.acceptance ?? []).some(item => item.status === 'deferred')) throw errorWithCode('DEFERRED_ACCEPTANCE', 'deferred acceptance criteria prevent close');
    if (current.tracker && !current.terminalProjection) throw errorWithCode('INVALID_TRANSITION', 'terminal projection intent is missing');
    return transitionRecord({
      ...current,
      tracker: current.tracker ? { ...current.tracker, projected: true, projectionRevision: current.terminalProjection.revision } : null,
      terminalProjection: null,
    }, 'Closed');
  });
}

export async function closeDeliveredUnit({ store, unit, adapter, queue, now, git }) {
  const record = await revalidateTerminalTarget({ store, unit, git });
  if (record?.next?.handoff || record?.state === 'SelfGated') return { ...record, closePending: true };
  const projected = await projectTerminalUnit({ store, unit, adapter, queue, now, git });
  if (!projected.projected) return { ...projected.record, closePending: true };
  const closed = await commitTerminalClose({ store, unit, git });
  return closed.state === 'Closed' ? closed : { ...closed, closePending: true };
}

export async function reconcileProjectionQueue({ queue, store, adapter, now, git }) {
  const outcomes = [];
  for (const entry of await queue.pending()) {
    try {
      if (entry.terminal) {
        const target = await revalidateTerminalTarget({ store, unit: entry.unit, git });
        if (target?.state !== 'Delivered') throw errorWithCode('INVALID_TRANSITION', 'terminal projection requires current Delivered acceptance');
      }
      if (!adapter || typeof adapter.read !== 'function' || typeof adapter.project !== 'function') {
        throw errorWithCode('ADAPTER_MISSING', 'tracker adapter must implement read and project');
      }
      const observed = await adapter.read(entry.tracker.ref);
      if (observed?.state !== entry.projection.state || observed?.revision !== entry.projection.revision) {
        await adapter.project(entry.tracker.ref, entry.projection);
      }
      await queue.projected(entry);
      if (entry.terminal) {
        const current = await store.read(entry.unit);
        if (current?.state === 'Delivered' && current.terminalProjection?.revision === entry.projection.revision) {
          await store.update(entry.unit, record => ({ ...record, tracker: { ...record.tracker, projected: true, projectionRevision: entry.projection.revision } }));
          if (!current.next?.handoff) await commitTerminalClose({ store, unit: entry.unit, git });
        }
      }
      outcomes.push({ id: entry.id, status: 'projected' });
    } catch (error) {
      outcomes.push({ id: entry.id, status: 'queued', error: error.message });
    }
  }
  return outcomes;
}
