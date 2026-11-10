import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { selectExecutionPolicy, validateGoal } from './continuity-decision.mjs';
import { effectArgsDigest } from './approvals.mjs';
import { acquireContinuityLock } from './continuity-lock.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
const failure = (code, message) => Object.assign(new Error(message), { code });
let sequence = 0;

export function createContinuityStore(stateRoot) {
  const root = path.resolve(stateRoot, 'goals');
  function paths(id) {
    if (!identity(id)) throw failure('CONTINUITY_INVALID', 'invalid goal id');
    const directory = path.join(root, id);
    return { directory, record: path.join(directory, 'goal.json'), lock: path.join(directory, '.lock') };
  }
  async function read(id) {
    try {
      const record = JSON.parse(await readFile(paths(id).record, 'utf8'));
      if (record.schema !== 'harness.goal/1' || record.goal?.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1) throw failure('CONTINUITY_INVALID', 'invalid stored goal');
      validateGoal(record.goal); selectExecutionPolicy(record.policy, 'implementation');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function transaction(id, change, { completionReservation, reworkReservation } = {}) {
    const files = paths(id);
    await mkdir(files.directory, { recursive: true });
    const lock = await acquireContinuityLock(files.lock);
    let temporary;
    try {
      const current = await read(id);
      if (current?.completionReservation && effectArgsDigest(current.completionReservation) !== completionReservation)
        throw failure('GOAL_COMPLETING', 'goal completion is reserved by its finalizer');
      if (current?.reworkReservation && current.reworkReservation.requestDigest !== reworkReservation)
        throw failure('GOAL_REWORKING', 'goal is reserved by delivered rework');
      const next = await change(current);
      if (next === current) return current;
      if (next.schema !== 'harness.goal/1' || next.goal?.id !== id || next.revision !== (current?.revision ?? 0) + 1) throw failure('CONTINUITY_INVALID', 'invalid goal transition');
      validateGoal(next.goal); selectExecutionPolicy(next.policy, 'implementation');
      temporary = `${files.record}.tmp-${process.pid}-${++sequence}`;
      const output = await open(temporary, 'wx', 0o600);
      try { await output.writeFile(`${JSON.stringify(next, null, 2)}\n`); await output.sync(); } finally { await output.close(); }
      lock.assertHeld();
      await rename(temporary, files.record); temporary = null;
      const directory = await open(files.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return next;
    } finally {
      if (temporary) await rm(temporary, { force: true });
      await lock.close();
    }
  }
  async function create({ goal, policy, source }) {
    validateGoal(goal); selectExecutionPolicy(policy, 'implementation');
    if (!source || typeof source.path !== 'string' || !path.isAbsolute(source.path) || !digestPattern.test(source.digest ?? '')) throw failure('CONTINUITY_INVALID', 'goal source must have an absolute path and digest');
    if (goal.status !== 'active' || !goal.remaining.length) throw failure('CONTINUITY_INVALID', 'new goal must have active work');
    return transaction(goal.id, current => {
      const definitionDigest = effectArgsDigest({goal,policy,source});
      const next = { schema: 'harness.goal/1', revision: 1, goal, policy, source, definitionDigest };
      if (current) {
        if (current.definitionDigest !== definitionDigest) throw failure('GOAL_CONFLICT', 'goal id is already bound to a different definition');
        return current;
      }
      return next;
    });
  }
  return Object.freeze({ read, create, transaction });
}
