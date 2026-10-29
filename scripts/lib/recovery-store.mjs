import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCauseKey, decideFailure, finishResolver, reserveRetry, resumeFailure, transitionForFailure } from './classify.mjs';
import { decideResume } from './resume.mjs';

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function unitName(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '.' || unit === '..') {
    throw new TypeError('unit must be a path-safe identifier');
  }
  return unit;
}

function parseCauses(content) {
  if (!content) return {};
  const causes = JSON.parse(content);
  if (!causes || typeof causes !== 'object' || Array.isArray(causes)) throw new TypeError('cause registry must be an object');
  return causes;
}

export function createRecoveryStore(stateRoot) {
  const root = path.resolve(stateRoot);
  const registryFile = path.join(root, 'causes.json');
  const lockFile = `${registryFile}.lock`;
  let temporarySequence = 0;

  async function withRegistry(action) {
    await mkdir(root, { recursive: true });
    let lock;
    while (!lock) {
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(lockFile, 'utf8')); }
        catch { throw Object.assign(new Error('cause registry lock is unreadable; inspect it before retrying'), { code: 'CAUSE_LOCK_INVALID' }); }
        const pid = owner?.pid;
        if (!Number.isSafeInteger(pid) || pid < 1) throw Object.assign(new Error('cause registry lock has no valid owner; inspect it before retrying'), { code: 'CAUSE_LOCK_INVALID' });
        try { process.kill(pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') throw Object.assign(new Error(`cause registry lock owner exited: ${pid}`), { code: 'CAUSE_LOCK_ORPHANED' });
          if (probe.code !== 'EPERM') throw probe;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      const causes = parseCauses(await readFile(registryFile, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)));
      const result = await action(causes);
      temporarySequence += 1;
      const temporary = `${registryFile}.tmp-${process.pid}-${temporarySequence}`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(causes, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, registryFile);
      const directory = await open(root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally {
      await lock.close();
      await rm(lockFile, { force: true });
    }
  }

  async function writeFailure(record) {
    const directory = path.join(root, 'units', unitName(record.unit), 'failures');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${record.id}.json`);
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const temporary = `${file}.tmp-${process.pid}-${++temporarySequence}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    return { path: path.relative(root, file), digest: digest(content) };
  }

  return Object.freeze({
    async record({ store, unit, failure, retryLimit = 2, resolverLimit = 2, needsDiagnosis = false, resolverDepth = 0, adapters }) {
      unitName(unit);
      if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('Unit Record store is required');
      if (!adapters || typeof adapters.id !== 'function' || typeof adapters.now !== 'function') throw new TypeError('recovery adapters are required');
      return withRegistry(async causes => {
        const current = await store.read(unit);
        if (!current) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
        const key = createCauseKey(failure ?? {});
        const prior = causes[key];
        const decision = decideFailure({ failure, cause: prior, retryLimit, resolverLimit, needsDiagnosis, resolverDepth });
        const record = {
          id: adapters.id(), unit, class: decision.cause.class, failurePoint: failure.failurePoint,
          causeKey: decision.cause.causeKey, signature: decision.signature, occurrence: decision.cause.occurrences,
          action: decision.action, evidence: failure.evidence ?? null, reason: failure.reason,
          snapshot: failure.snapshot ?? null,
          recordedAt: adapters.now(),
        };
        const reference = await writeFailure(record);
        causes[record.causeKey] = {
          ...decision.cause,
          lastAction: decision.action === 'diagnose' && decision.cause.class === 'unknown' ? 'awaiting-diagnosis' : decision.action,
        };
        const updated = await store.update(unit, next => {
          const failed = { ...next, failures: [...(next.failures ?? []), reference] };
          return transitionForFailure(failed, decision);
        });
        return { failure: record, reference, decision, record: updated };
      });
    },
    async reserveRetry({ causeKey, retryLimit = 2 }) {
      if (typeof causeKey !== 'string' || !causeKey) throw new TypeError('causeKey is required');
      return withRegistry(async causes => {
        const prior = causes[causeKey];
        if (!prior || prior.lastAction !== 'diagnose' || prior.class === 'unknown') throw Object.assign(new Error('retry reservation requires completed diagnosis'), { code: 'DIAGNOSIS_REQUIRED' });
        if (prior.class !== 'product') throw Object.assign(new Error(`retry is not allowed for ${prior.class} failures`), { code: 'RETRY_NOT_ALLOWED' });
        const decision = reserveRetry(prior, retryLimit);
        if (decision.action === 'retry') causes[causeKey] = { ...decision.cause, lastAction: 'retry' };
        return decision;
      });
    },
    async finishResolver({ causeKey }) {
      if (typeof causeKey !== 'string' || !causeKey) throw new TypeError('causeKey is required');
      return withRegistry(async causes => {
        const prior = causes[causeKey];
        if (prior?.lastAction === 'resolver-completed' && prior.activeResolver === false) return prior;
        if (!prior || prior.class !== 'harness') throw Object.assign(new Error('no harness resolver is recorded for this cause'), { code: 'RESOLVER_NOT_ACTIVE' });
        const completed = { ...finishResolver(prior), lastAction: 'resolver-completed' };
        causes[causeKey] = completed;
        return completed;
      });
    },
    async confirmDiagnosis({ causeKey, classification }) {
      if (typeof causeKey !== 'string' || !causeKey) throw new TypeError('causeKey is required');
      if (!['product', 'harness', 'environment', 'user-domain'].includes(classification)) {
        throw Object.assign(new Error('diagnosis must confirm a known failure class'), { code: 'DIAGNOSIS_INVALID' });
      }
      return withRegistry(async causes => {
        const prior = causes[causeKey];
        if (prior?.lastAction === 'diagnose' && prior.class === classification) return prior;
        if (!prior || prior.lastAction !== 'awaiting-diagnosis' || prior.class !== 'unknown') {
          throw Object.assign(new Error('no unknown failure is awaiting diagnosis'), { code: 'DIAGNOSIS_NOT_PENDING' });
        }
        const diagnosed = { ...prior, class: classification, lastAction: 'diagnose' };
        causes[causeKey] = diagnosed;
        return diagnosed;
      });
    },
    async causes() {
      return parseCauses(await readFile(registryFile, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)));
    },
    async readFailure(unit, id) {
      unitName(unit);
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new TypeError('failure id is invalid');
      const file = path.join(root, 'units', unit, 'failures', `${id}.json`);
      return JSON.parse(await readFile(file, 'utf8'));
    },
  });
}

export async function resumeUnitFailure({ store, unit, snapshot }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('Unit Record store is required');
  const record = await store.read(unit);
  if (!record) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('resume snapshot is required');
  const recovery = decideResume({ record, ...snapshot });
  if (recovery.action !== 'resume') return { record, recovery };
  const updated = ['Blocked', 'Stopped'].includes(record.state)
    ? await store.update(unit, current => ({ ...current, ...resumeFailure(current) }))
    : record;
  const stage = ({ Scoped: 'scope', Implementing: 'implement', SelfGated: 'gates', InReview: 'review', Accepted: 'delivery', Delivering: 'delivery', Delivered: 'handoff' })[updated.state];
  return { record: updated, stage, recovery };
}
