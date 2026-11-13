import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCauseKey, decideFailure, finishResolver, reserveRetry, resumeFailure, transitionForFailure } from './classify.mjs';
import { decideResume } from './resume.mjs';
import { transitionRecord } from './unit-state.mjs';

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
    async record({ store, unit, failure, retryLimit = 2, resolverLimit = 2, needsDiagnosis = false, resolverDepth = 0,
      gateRecovery, revalidation, expectedRevision, adapters }) {
      unitName(unit);
      if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('Unit Record store is required');
      if (!adapters || typeof adapters.id !== 'function' || typeof adapters.now !== 'function') throw new TypeError('recovery adapters are required');
      return withRegistry(async causes => {
        const current = await store.read(unit);
        if (!current) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
        const assertRevision = record => {
          if (expectedRevision !== undefined && expectedRevision !== record.revision) {
            throw Object.assign(new Error('unit changed before failure could be recorded'), { code: 'STAGE_STALE' });
          }
        };
        assertRevision(current);
        const key = createCauseKey(failure ?? {});
        const prior = causes[key];
        const decision = decideFailure({ failure, cause: prior, retryLimit, resolverLimit, needsDiagnosis, resolverDepth });
        if (gateRecovery && decision.cause.class !== 'product') {
          throw Object.assign(new Error('captured gate repair cannot change the confirmed cause classification'), { code: 'RETRY_NOT_ALLOWED' });
        }
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
          assertRevision(next);
          const failed = { ...next, failures: [...(next.failures ?? []), reference] };
          if (gateRecovery) failed.feedback = [...(next.feedback ?? []), { kind: 'gate-failure', failure: reference, evidence: gateRecovery.baseline }];
          if (gateRecovery && ['stop', 'diagnose'].includes(decision.action)) {
            failed.gateRecovery = { ...gateRecovery, failure: reference, failureId: record.id, causeKey: record.causeKey,
              status: decision.action === 'diagnose' ? 'ordinary-diagnosis' : gateRecovery.status };
          }
          if (revalidation) {
            failed.retryContinuations = next.retryContinuations.map(receipt => receipt.failureId !== revalidation.failureId ? receipt
              : { ...receipt, result: { evidence: gateRecovery.baseline, failure: reference, progress: gateRecovery.status === 'diagnose' } });
          }
          return transitionForFailure(failed, decision);
        });
        return { failure: record, reference, decision, record: updated };
      });
    },
    async reserveRetry({ causeKey, retryLimit = 2, apply }) {
      if (typeof causeKey !== 'string' || !causeKey) throw new TypeError('causeKey is required');
      return withRegistry(async causes => {
        const prior = causes[causeKey];
        if (!prior || prior.lastAction !== 'diagnose' || prior.class === 'unknown') throw Object.assign(new Error('retry reservation requires completed diagnosis'), { code: 'DIAGNOSIS_REQUIRED' });
        if (prior.class !== 'product') throw Object.assign(new Error(`retry is not allowed for ${prior.class} failures`), { code: 'RETRY_NOT_ALLOWED' });
        const decision = reserveRetry(prior, retryLimit);
        if (apply) await apply(decision);
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
    async continueResolved({ causeKey, expected, receipt, apply }) {
      return withRegistry(async causes => {
        const prior = causes[causeKey];
        if (!prior || digest(JSON.stringify(prior)) !== digest(JSON.stringify(expected)) || prior.activeResolver) {
          throw Object.assign(new Error('cause or resolver reservation changed'), { code: 'RETRY_NOT_ALLOWED' });
        }
        if (prior.continuations?.some(item => item.proof.progressDigest === receipt.proof.progressDigest)) {
          throw Object.assign(new Error('the correction observation was already used'), { code: 'RETRY_NO_PROGRESS' });
        }
        await apply();
        causes[causeKey] = { ...prior, continuations: [...(prior.continuations ?? []), receipt] };
      });
    },
    async readFailure(unit, id) {
      unitName(unit);
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new TypeError('failure id is invalid');
      const file = path.join(root, 'units', unit, 'failures', `${id}.json`);
      return JSON.parse(await readFile(file, 'utf8'));
    },
  });
}

export async function resumeUnitFailure({ store, unit, snapshot, validateStopped, validateResolution, lockMetadata }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('Unit Record store is required');
  const record = await store.read(unit);
  if (!record) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('resume snapshot is required');
  let recovery = decideResume({ ...snapshot, record, evidence: record.evidence ?? [] });
  const resolution = record.retryResolutions?.at(-1);
  const pendingResolution = record.state === 'Stopped' && resolution && !record.retryResumptions?.some(item => item.requestDigest === resolution.requestDigest)
    && record.failures?.at(-1)?.digest === resolution.failureRef.digest;
  if (pendingResolution && recovery.action === 'resume') {
    recovery = { ...recovery, action: 'revalidate', resumeState: recovery.state, nextStage: 'gates', reason: 'verified correction of exhausted cause' };
  }
  const revalidate = ['rerun-gate', 'revalidate'].includes(recovery.action);
  if (recovery.action !== 'resume' && !revalidate) return { record, recovery };
  const beforeGates = ['Scoped', 'Implementing'].includes(recovery.resumeState) && !record.accepted;
  if (revalidate && (!(beforeGates || ['SelfGated', 'InReview', 'Accepted'].includes(recovery.resumeState))
    || ['review', 'ops'].includes(record.kind) || record.deliveryPlan || record.deliveryResult
    || record.sessionFinalization && record.sessionFinalization.mode !== 'stopped')) return { record, recovery };
  const updated = revalidate || ['Blocked', 'Stopped'].includes(record.state)
    ? await store.update(unit, async current => {
      if (current.revision !== record.revision) throw Object.assign(new Error('unit changed before resume'), {code:'CONTINUITY_STALE'});
      if (pendingResolution) {
        if (!validateResolution) throw Object.assign(new Error('correction resume requires current trusted verification'), { code: 'RETRY_RESOLUTION_UNPROVEN' });
        await validateResolution(current, resolution);
      }
      let observation;
      if (current.state === 'Stopped' && current.stopReport && !current.sessionFinalization) {
        if (!validateStopped) throw Object.assign(new Error('retained stopped owner closure is not verified'), {code:'SESSION_CLOSE_PENDING'});
        observation = await validateStopped(current, { recovery });
        if (!observation) throw Object.assign(new Error('retained stopped owner closure is not verified'), {code:'SESSION_CLOSE_PENDING'});
      }
      if (current.sessionFinalization?.mode === 'stopped' && !current.sessionFinalization.closeReceipt?.result?.closed)
        throw Object.assign(new Error('stopped owner closure is not verified'), {code:'SESSION_CLOSE_PENDING'});
      let resumed = ['Blocked', 'Stopped'].includes(current.state) ? { ...current, ...resumeFailure(current) } : { ...current };
      if (current.sessionFinalization?.mode === 'stopped') {
        resumed.sessionHistory = [...(current.sessionHistory ?? []), current.sessionFinalization];
        resumed.sessionFinalization = null;
      }
      if (observation) resumed.sessionHistory = [...(current.sessionHistory ?? []), observation];
      if (pendingResolution) resumed.retryResumptions = [...(current.retryResumptions ?? []),
        { requestDigest: resolution.requestDigest, revision: current.revision + 1 }];
      if (pendingResolution && current.gateRecovery) {
        resumed.gateRecoveryHistory = [...(current.gateRecoveryHistory ?? []), current.gateRecovery];
        resumed.gateRecovery = null;
      }
      if (revalidate) {
        const latest = new Map((current.evidence ?? []).map(item => [item.gate, item]));
        const invalidated = [...latest.values()].filter(item => recovery.action === 'revalidate' || item.gate === recovery.gate)
          .map(item => ({ ...item, status: 'stale', covers: [] }));
        resumed = { ...resumed, accepted: null, reviewDecision: null, reviewedHead: null, verdict: null,
          evidence: [...(current.evidence ?? []), ...invalidated],
          resumeRevalidations: [...(current.resumeRevalidations ?? []), { revision: current.revision + 1, fromState: current.state,
            resumeState: recovery.resumeState, recovery, previousAcceptance: current.accepted ?? null,
            previousReview: { reviewDecision: current.reviewDecision ?? null, reviewedHead: current.reviewedHead ?? null, verdict: current.verdict ?? null } }] };
        if (!beforeGates && resumed.state !== 'SelfGated') resumed = transitionRecord(resumed, 'SelfGated');
      }
      return resumed;
    }, { lockMetadata }) : record;
  const stage = ({ Scoped: 'scope', Implementing: 'implement', SelfGated: 'gates', InReview: 'review', Accepted: 'delivery', Delivering: 'delivery', Delivered: 'handoff' })[updated.state];
  return { record: updated, stage, recovery };
}
