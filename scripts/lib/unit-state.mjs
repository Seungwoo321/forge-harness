import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const schema = 'harness.unit/1';
const activeStates = new Set([
  'Scoped', 'Implementing', 'SelfGated', 'InReview', 'Accepted', 'Delivering', 'Delivered',
]);
const transitions = {
  Scoped: new Set(['Implementing', 'Closed']),
  Implementing: new Set(['SelfGated']),
  SelfGated: new Set(['Implementing', 'InReview', 'Accepted']),
  InReview: new Set(['Implementing', 'SelfGated', 'Accepted', 'Closed']),
  Accepted: new Set(['SelfGated', 'Delivering']),
  Delivering: new Set(['Implementing', 'SelfGated', 'Delivered']),
  Delivered: new Set(['SelfGated', 'Implementing', 'Closed']),
};
let tempSequence = 0;

function unitPathPart(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '.' || unit === '..') {
    throw new TypeError('unit must be a path-safe identifier');
  }
  return unit;
}

function validateRecord(record, unit) {
  if (!record || record.schema !== schema || record.unit !== unit) {
    throw new TypeError(`expected ${schema} record for ${unit}`);
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new TypeError('revision must be a positive safe integer');
  }
  if (!activeStates.has(record.state) && record.state !== 'Blocked' && record.state !== 'Stopped' && record.state !== 'Closed') {
    throw new TypeError(`unknown unit state: ${record.state}`);
  }
  if (typeof record.kind !== 'string' || !record.kind) throw new TypeError('kind is required');
  return record;
}

function statesFor(kind) {
  if (kind === 'ops') return new Set(['Scoped', 'Blocked', 'Stopped', 'Closed']);
  if (kind === 'review') return new Set(['InReview', 'Blocked', 'Stopped', 'Closed']);
  if (['chore', 'impl', 'impl-risk', 'design'].includes(kind)) {
    return new Set([...activeStates, 'Blocked', 'Stopped', 'Closed']);
  }
  throw new TypeError(`unsupported unit kind: ${kind}`);
}

function reject(from, to, reason) {
  const error = new Error(`transition ${from} → ${to} rejected: ${reason}`);
  error.code = 'INVALID_TRANSITION';
  error.reason = reason;
  throw error;
}

export function transitionRecord(record, to) {
  const allowedStates = statesFor(record.kind);
  if (!allowedStates.has(to)) reject(record.state, to, `state is not allowed for kind ${record.kind}`);

  if (to === 'Blocked' || to === 'Stopped') {
    if (!activeStates.has(record.state) && record.state !== 'Blocked') {
      reject(record.state, to, 'only an active state can be blocked or stopped');
    }
    const next = { ...record, state: to };
    if (to === 'Blocked') next.blockedFrom = record.state;
    else next.stoppedFrom = record.state === 'Blocked' ? record.blockedFrom : record.state;
    return next;
  }

  if (record.state === 'Blocked' || record.state === 'Stopped') {
    const returnState = record.state === 'Blocked' ? record.blockedFrom : record.stoppedFrom;
    if (!returnState || to !== returnState) {
      reject(record.state, to, `must resume at ${returnState ?? 'the recorded origin state'}`);
    }
    return {
      ...record,
      state: to,
      blockedFrom: null,
      stoppedFrom: null,
    };
  }

  if (record.state === 'Closed' || !transitions[record.state]?.has(to)) {
    reject(record.state, to, 'transition is not in the unit lifecycle');
  }

  if (record.kind === 'ops' && !(record.state === 'Scoped' && to === 'Closed')) {
    reject(record.state, to, 'ops units close without implementation stages');
  }
  if (record.kind === 'review' && !(
    (record.state === 'InReview' && to === 'Closed') ||
    (record.state === 'InReview' && to === 'Blocked') ||
    (record.state === 'InReview' && to === 'Stopped')
  )) {
    reject(record.state, to, 'review units use the InReview → Closed lifecycle');
  }

  return { ...record, state: to };
}

export function createUnitStateStore(stateRoot) {
  const root = path.resolve(stateRoot);

  function pathsFor(unit) {
    const name = unitPathPart(unit);
    const dir = path.join(root, 'units', name);
    return { dir, record: path.join(dir, 'unit.json'), lock: path.join(dir, '.lock') };
  }

  async function waitForLock(paths) {
    let content;
    try { content = await readFile(paths.lock, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let owner;
    try { owner = JSON.parse(content).pid; } catch { owner = null; }
    if (!Number.isSafeInteger(owner) || owner < 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return;
    }
    try {
      process.kill(owner, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        const locked = new Error(`unit lock owner has exited: ${path.basename(paths.dir)}`);
        locked.code = 'UNIT_LOCK_ORPHANED';
        throw locked;
      }
      if (error.code !== 'EPERM') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  async function withLock(paths, action) {
    await mkdir(paths.dir, { recursive: true });
    let lock;
    while (!lock) {
      try {
        lock = await open(paths.lock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await waitForLock(paths);
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      return await action();
    } finally {
      await lock.close();
      await rm(paths.lock, { force: true });
    }
  }

  async function readUnlocked(paths, unit) {
    let record;
    try {
      record = JSON.parse(await readFile(paths.record, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return validateRecord(record, unit);
  }

  async function writeUnlocked(paths, record) {
    tempSequence += 1;
    const temp = `${paths.record}.tmp-${process.pid}-${tempSequence}`;
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, paths.record);
      const dir = await open(paths.dir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      if (handle) await handle.close();
      await rm(temp, { force: true });
      throw error;
    }
  }

  return Object.freeze({
    async read(unit) {
      const paths = pathsFor(unit);
      return await readUnlocked(paths, unit);
    },

    async withLock(unit, action) {
      const paths = pathsFor(unit);
      return await withLock(paths, async () => {
        const current = await readUnlocked(paths, unit);
        if (!current) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
        return await action(structuredClone(current));
      });
    },

    async create(record) {
      const unit = unitPathPart(record?.unit);
      const paths = pathsFor(unit);
      return await withLock(paths, async () => {
        if (await readUnlocked(paths, unit)) {
          const error = new Error(`unit already exists: ${unit}`);
          error.code = 'UNIT_EXISTS';
          throw error;
        }
        const next = validateRecord({ ...record, revision: 1 }, unit);
        await writeUnlocked(paths, next);
        return next;
      });
    },

    async update(unit, mutate) {
      const paths = pathsFor(unit);
      return await withLock(paths, async () => {
        const current = await readUnlocked(paths, unit);
        if (!current) {
          const error = new Error(`unit not found: ${unit}`);
          error.code = 'UNIT_NOT_FOUND';
          throw error;
        }
        const candidate = await mutate(structuredClone(current));
        if (!candidate || candidate.unit !== unit || candidate.schema !== schema) {
          throw new TypeError('update must preserve the unit identity and schema');
        }
        const next = validateRecord({ ...candidate, revision: current.revision + 1 }, unit);
        await writeUnlocked(paths, next);
        return next;
      });
    },

    async transition(unit, to) {
      return await this.update(unit, record => transitionRecord(record, to));
    },

    async location(unit) {
      const paths = pathsFor(unit);
      const info = await stat(paths.record).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      return info ? paths.record : null;
    },
  });
}

export async function reconcileTracker(record, adapter) {
  validateRecord(record, record.unit);
  if (!record.tracker) return { status: 'skipped', reason: 'no tracker configured' };
  const observed = await adapter.read(record.tracker.ref);
  if (observed?.state === record.state && observed?.revision === record.revision) {
    return { status: 'current', revision: record.revision };
  }
  await adapter.project(record.tracker.ref, {
    unit: record.unit,
    state: record.state,
    revision: record.revision,
  });
  return { status: 'projected', revision: record.revision };
}
