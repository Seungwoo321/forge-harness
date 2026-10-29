import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { authorizeDelivery } from './delivery.mjs';
import { executeEffect, createLedgerStore } from './ledger.mjs';
import { formatUnitResult, prepareSuccessor, validateHandoffPacket, writeUnitResult } from './report.mjs';
import { resolvePolicy } from './policy.mjs';
import { commitTerminalClose, createProjectionQueue, projectTerminalUnit } from './tracker.mjs';
import { executeDelivery } from './delivery-flow.mjs';

let temporarySequence = 0;

function lineValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

async function writeHandoff(stateRoot, slug, content) {
  const directory = path.join(path.resolve(stateRoot), 'handoff');
  const file = path.join(directory, `${slug}.md`);
  await mkdir(directory, { recursive: true });
  temporarySequence += 1;
  const temporary = `${file}.tmp-${process.pid}-${temporarySequence}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  const digest = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
  return { path: file, digest };
}

export async function finishSessionUnit({
  stateRoot, store, unit, resultFields, handoffContent, successor = null, goalComplete = false,
  parentSessionId, parentRuntime, requestedDelivery = 'none', delivery, trackerAdapter, sessionAdapter, adapters,
}) {
  let record = await store.read(unit);
  if (!record || !['Accepted', 'Delivering', 'Delivered'].includes(record.state)) throw Object.assign(new Error('session finish requires an Accepted, Delivering, or Delivered Unit Record'), { code: 'INVALID_TRANSITION' });
  if (!adapters || typeof adapters.now !== 'function') throw new TypeError('session flow adapters are required');
  if (!['execute', 'verify'].every(name => typeof sessionAdapter?.[name] === 'function')) {
    if (successor?.approved) throw Object.assign(new Error('session start adapter is unavailable'), { code: 'ADAPTER_MISSING' });
  }
  const unresolved = await createLedgerStore(stateRoot).withLock(unit, async ledger => {
    const entries = await ledger.read();
    const complete = new Set(entries.filter(row => row.event === 'result').map(row => row.seq));
    return entries.filter(row => row.event === 'intent' && !complete.has(row.seq));
  });
  const pendingSessionStart = successor?.approved && unresolved.length === 1
    && unresolved[0].effect === 'session.start'
    && unresolved[0].args?.unit === successor.unit
    && unresolved[0].args?.role === (successor.role ?? 'implementation')
    && unresolved[0].args?.attempt === (successor.attempt ?? 1)
    && unresolved[0].args?.cwd === successor.cwd;
  const pendingDelivery = record.state === 'Delivering' && unresolved.every(row => ['git.commit', 'git.push', 'git.integrate', 'pr.create', 'pr.merge'].includes(row.effect));
  if (unresolved.length && !pendingSessionStart && !pendingDelivery) {
    throw Object.assign(new Error('unresolved effect intent prevents session handoff'), { code: 'EFFECT_UNCERTAIN' });
  }
  let pendingFiles = null;
  if (pendingSessionStart) {
    try {
      const args = unresolved[0].args;
      const handoff = record.next?.handoff;
      const resultRef = record.resultRef;
      const digest = `sha256:${createHash('sha256').update(handoffContent.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')).digest('hex')}`;
      if (!handoff || record.next.unit !== successor.unit || handoff.path !== args.handoffPath
        || handoff.digest !== args.handoffDigest || digest !== args.handoffDigest || !resultRef) throw new Error('handoff binding changed');
      const resultContent = formatUnitResult({ ...resultFields, outcome: { kind: 'next', path: handoff.path, unit: successor.unit } });
      const packetBytes = await readFile(handoff.path);
      const resultBytes = await readFile(resultRef.path);
      if (`sha256:${createHash('sha256').update(packetBytes).digest('hex')}` !== handoff.digest
        || `sha256:${createHash('sha256').update(resultBytes).digest('hex')}` !== resultRef.digest
        || resultBytes.toString('utf8') !== `${resultContent}\n` || record.result !== resultContent) throw new Error('pending handoff or result changed');
      pendingFiles = { handoff, resultContent, resultPath: resultRef.path, resultDigest: resultRef.digest };
    } catch (cause) {
      throw Object.assign(new Error('unresolved session start requires its original handoff and result', { cause }), { code: 'EFFECT_UNCERTAIN' });
    }
  }
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const authorized = authorizeDelivery(policy, requestedDelivery);
  if (!successor?.approved && !goalComplete) throw Object.assign(new Error('session finish requires an approved successor or confirmed goal completion'), { code: 'USER_DECISION_REQUIRED' });
  formatUnitResult({ ...resultFields, outcome: { kind: 'complete' } });
  if (parentRuntime !== undefined) {
    if (!parentRuntime || typeof parentRuntime.sessionId !== 'string' || !parentRuntime.sessionId
      || typeof parentRuntime.cwd !== 'string' || !path.isAbsolute(parentRuntime.cwd)
      || (parentRuntime.incarnationId !== undefined && (typeof parentRuntime.incarnationId !== 'string' || !parentRuntime.incarnationId))
      || (parentSessionId !== undefined && parentSessionId !== parentRuntime.sessionId)) {
      throw Object.assign(new Error('parentRuntime requires an exact session identity and absolute cwd'), { code: 'SESSION_OWNER_MISMATCH' });
    }
    parentSessionId = parentRuntime.sessionId;
  }
  if ((record.openDecisions ?? []).length) throw Object.assign(new Error('unresolved decisions prevent session finish'), { code: 'USER_DECISION_REQUIRED' });
  const observeParent = async () => {
    const parentCwd = parentRuntime?.cwd ?? successor.cwd;
    const owner = await sessionAdapter.observe({ cwd: parentCwd, targetCwd: successor.cwd });
    if (owner?.sessionId !== parentSessionId || owner?.cwd !== parentCwd
      || (parentRuntime?.incarnationId !== undefined && owner?.incarnationId !== parentRuntime.incarnationId)
      || (owner?.targetCwd !== undefined && owner.targetCwd !== successor.cwd)) {
      throw Object.assign(new Error('current session owner does not match the requested cwd and parent'), { code: 'SESSION_OWNER_MISMATCH' });
    }
    return owner;
  };
  if (successor?.approved) {
    validateHandoffPacket(handoffContent);
    lineValue(successor.unit, 'successor unit');
    lineValue(successor.cwd, 'successor cwd');
    if (!path.isAbsolute(successor.cwd)) throw Object.assign(new Error('successor cwd must be absolute'), { code: 'SESSION_OWNER_MISMATCH' });
    if (successor.sessionId && successor.sessionId === parentSessionId) throw new Error('successor must run in a new session');
    if (typeof sessionAdapter?.observe !== 'function') throw Object.assign(new Error('current session owner cannot be verified'), { code: 'ADAPTER_MISSING' });
    await observeParent();
  }
  if (typeof adapters.git?.inspectUnit !== 'function') throw Object.assign(new Error('delivery requires Git inspection'), { code: 'ADAPTER_MISSING' });
  const delivered = await executeDelivery({ stateRoot, store, unit, requestedDelivery, delivery, adapters });
  if (delivered.code !== 0) return delivered;
  record = await store.read(unit);
  const handoff = pendingFiles?.handoff ?? (successor?.approved ? await writeHandoff(stateRoot, unit, handoffContent) : null);
  const outcome = successor?.approved
    ? { kind: 'next', path: handoff.path, unit: lineValue(successor.unit, 'successor unit') }
    : goalComplete
      ? { kind: 'complete' }
      : null;
  if (!outcome) throw Object.assign(new Error('session finish requires an approved successor or confirmed goal completion'), { code: 'USER_DECISION_REQUIRED' });
  const resultContent = pendingFiles?.resultContent ?? formatUnitResult({ ...resultFields, outcome });
  const resultPath = pendingFiles?.resultPath ?? await writeUnitResult(stateRoot, unit, resultContent);
  const resultDigest = pendingFiles?.resultDigest ?? `sha256:${createHash('sha256').update(await readFile(resultPath)).digest('hex')}`;
  if (!pendingFiles) await store.update(unit, current => ({
    ...current,
    result: resultContent,
    resultRef: { path: resultPath, digest: resultDigest },
    next: handoff ? { unit: successor.unit, handoff } : null,
  }));
  const projected = await projectTerminalUnit({
    store, unit, adapter: trackerAdapter, queue: createProjectionQueue(stateRoot, adapters), now: () => adapters.now(), git: adapters.git,
  });
  if (!projected.projected) return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, delivery: authorized, successor: null, summary: 'Final tracker projection is queued; successor session has not started' };
  if (!successor?.approved) {
    const closed = await commitTerminalClose({ store, unit, git: adapters.git });
    return { code: closed.state === 'Closed' ? 0 : 1, state: closed.state, resultPath, resultDigest, delivery: authorized, successor: null, summary: 'Unit completed' };
  }
  const current = await store.read(unit);
  const preparation = prepareSuccessor({
    record: { ...current, tracker: current.tracker ? { ...current.tracker, projected: true } : null },
    handoff: handoffContent,
    successor: { ...successor, handoffPath: handoff.path, handoffDigest: handoff.digest }, parentSessionId,
  });

  const validateWorker = result => {
    if (typeof result?.sessionId !== 'string' || !result.sessionId || result.sessionId === parentSessionId
      || (result.cwd !== undefined && result.cwd !== successor.cwd)) {
      throw Object.assign(new Error('successor runtime identity or cwd is unverified'), { code: 'SESSION_OBSERVATION_INVALID' });
    }
    return result;
  };
  const started = await executeEffect({
    unit,
    effect: 'session.start',
    args: { unit: preparation.unit, role: successor.role ?? 'implementation', attempt: successor.attempt ?? 1, cwd: successor.cwd, handoffPath: handoff.path, handoffDigest: handoff.digest },
    policy,
    context: { explicitUserInstruction: true, productOwned: true },
    approvalRef: successor.approvalRef ?? null,
    store: createLedgerStore(stateRoot),
    adapter: {
      now: () => adapters.now(),
      async execute(input) {
        await observeParent();
        return validateWorker(await sessionAdapter.execute(input));
      },
      async verify(input) {
        const verified = await sessionAdapter.verify(input);
        if (verified?.status === 'completed') {
          try { validateWorker(verified.result); } catch { return { status: 'unknown' }; }
        }
        return verified;
      },
    },
  });
  const sessionId = started.result?.sessionId;
  if (!['completed', 'duplicate', 'reconciled'].includes(started.status) || typeof sessionId !== 'string' || !sessionId || sessionId === parentSessionId
    || (started.result?.cwd !== undefined && started.result.cwd !== successor.cwd)) {
    return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, delivery: authorized, successor: preparation, session: started, summary: 'Successor session start is unresolved or did not create a new session' };
  }
  const closed = await commitTerminalClose({ store, unit, git: adapters.git, sessionStart: started });
  return { code: closed.state === 'Closed' ? 0 : 1, state: closed.state, resultPath, resultDigest, handoff, delivery: authorized, successor: preparation, sessionId, summary: 'Successor started in a new session' };
}
