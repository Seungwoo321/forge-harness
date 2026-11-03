import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { authorizeDelivery } from './delivery.mjs';
import { executeEffect, createLedgerStore } from './ledger.mjs';
import { formatUnitResult, prepareSuccessor, validateHandoffPacket, writeUnitResult } from './report.mjs';
import { prepareEffect, resolvePolicy } from './policy.mjs';
import { effectArgsDigest } from './approvals.mjs';
import { taskPackets, validateTaskReceipt } from './session-task.mjs';
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
  stateRoot, store, unit, resultFields, handoffContent, successor = null, goalComplete = false, sameSession = null,
  parentSessionId, parentRuntime, returnTo, requestedDelivery, delivery, trackerAdapter, sessionAdapter, adapters,
}) {
  let record = await store.read(unit);
  if (record?.sessionFinalization) return { code: 3, state: record.state, finalizePending: true, summary: 'Session finalization requires surviving supervisor verification' };
  if (sameSession !== null && (!sameSession || typeof sameSession !== 'object' || Array.isArray(sameSession)
    || Object.keys(sameSession).sort().join(',') !== 'approved,nextUnit' || sameSession.approved !== true
    || typeof sameSession.nextUnit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sameSession.nextUnit)
    || ['.', '..', unit].includes(sameSession.nextUnit) || successor || goalComplete || returnTo)) {
    throw Object.assign(new Error('same-session continuation requires one approved next unit and no transfer or goal completion'), { code: 'SESSION_CONTINUATION_INVALID' });
  }
  if (!record || !['Accepted', 'Delivering', 'Delivered'].includes(record.state)) throw Object.assign(new Error('session finish requires an Accepted, Delivering, or Delivered Unit Record'), { code: 'INVALID_TRANSITION' });
  if (record.sameSessionContinuation && !sameSession) throw Object.assign(new Error('same-session continuation is already bound'), { code: 'SESSION_CONTINUATION_CONFLICT' });
  if ((parentRuntime || parentSessionId) && !successor?.approved && !returnTo && !sameSession) throw Object.assign(new Error('session completion requires an exact result recipient'), { code: 'SESSION_OWNER_MISMATCH' });
  if (!adapters || typeof adapters.now !== 'function') throw new TypeError('session flow adapters are required');
  if (!['execute', 'verify'].every(name => typeof sessionAdapter?.[name] === 'function')) {
    if (successor?.approved || returnTo) throw Object.assign(new Error('session adapter is unavailable'), { code: 'ADAPTER_MISSING' });
  }
  const entries = await createLedgerStore(stateRoot).withLock(unit, ledger => ledger.read());
  const complete = new Set(entries.filter(row => row.event === 'result').map(row => row.seq));
  const unresolved = entries.filter(row => row.event === 'intent' && !complete.has(row.seq));
  const existingStart = entries.findLast(row => row.event === 'intent' && row.effect === 'session.start');
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
  if (existingStart) {
    try {
      const args = existingStart.args;
      if (!successor?.approved || args.unit !== successor.unit || args.role !== (successor.role ?? 'implementation')
        || args.attempt !== (successor.attempt ?? 1) || args.cwd !== successor.cwd) throw new Error('successor binding changed');
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
      throw Object.assign(new Error('existing session start requires its original handoff and result', { cause }), { code: 'EFFECT_UNCERTAIN' });
    }
  }
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  requestedDelivery ??= record.policyChanges?.length ? policy.delivery : 'none';
  if (record.policyChanges?.length && requestedDelivery !== policy.delivery) throw Object.assign(new Error('finish delivery must match the explicitly authorized unit policy'), { code: 'POLICY_CHANGE_MISMATCH' });
  const authorized = authorizeDelivery(policy, requestedDelivery);
  if (!successor?.approved && !goalComplete && !sameSession) throw Object.assign(new Error('session finish requires an approved successor or confirmed goal completion'), { code: 'USER_DECISION_REQUIRED' });
  formatUnitResult({ ...resultFields, outcome: sameSession ? { kind: 'continue', unit: sameSession.nextUnit } : { kind: 'complete' } });
  if (sameSession) {
    const intent = effectArgsDigest({ sameSession, resultFields });
    const bindingFor = current => {
      const currentPolicy = resolvePolicy({ unit: current.policyOverrides ?? {}, project: current.policy ?? {} }, { nonInteractive: true }).policy;
      const accepted = current.accepted ?? {};
      return effectArgsDigest({ policy: currentPolicy, epoch: current.policyChanges?.at(-1)?.revision ?? 0,
        accepted: { validatedHead: accepted.validatedHead ?? accepted.head, contentFingerprint: accepted.contentFingerprint,
          repo: accepted.repo, branch: accepted.branch, tree: accepted.tree, base: accepted.base } });
    };
    const binding = bindingFor(record), alreadyBound = new Error('same-session continuation already bound');
    try { await store.update(unit, current => {
      if (bindingFor(current) !== binding || current.sameSessionContinuation && current.sameSessionContinuation.intent !== intent) {
        throw Object.assign(new Error('same-session continuation or accepted target changed'), { code: 'SESSION_CONTINUATION_CONFLICT' });
      }
      const previous = current.sameSessionContinuation, policyEpoch = current.policyChanges?.at(-1)?.revision ?? 0;
      if (previous && previous.delivery !== requestedDelivery && previous.policyEpoch === policyEpoch) {
        throw Object.assign(new Error('same-session delivery level changed without an authorized policy revision'), { code: 'SESSION_CONTINUATION_CONFLICT' });
      }
      if (previous?.binding === binding && previous.delivery === requestedDelivery) throw alreadyBound;
      if (current.state !== 'Accepted') throw Object.assign(new Error('same-session continuation must be fixed before delivery'), { code: 'INVALID_TRANSITION' });
      return { ...current, sameSessionContinuation: { intent, binding, delivery: requestedDelivery, policyEpoch, nextUnit: sameSession.nextUnit,
        bindings: [...(previous?.bindings ?? (previous ? [previous.binding] : [])), binding] } };
    }); } catch (error) { if (error !== alreadyBound) throw error; }
    record = await store.read(unit);
  }
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
  let owner;
  const observeParent = async () => {
    const parentCwd = parentRuntime?.cwd ?? successor?.cwd;
    const targetCwd = successor?.cwd ?? parentCwd;
    owner = await sessionAdapter.observe({ cwd: parentCwd, targetCwd });
    if (owner?.sessionId !== parentSessionId || owner?.cwd !== parentCwd
      || (parentRuntime?.incarnationId !== undefined && owner?.incarnationId !== parentRuntime.incarnationId)
      || (owner?.targetCwd !== undefined && owner.targetCwd !== targetCwd)) {
      throw Object.assign(new Error('current session owner does not match the requested cwd and parent'), { code: 'SESSION_OWNER_MISMATCH' });
    }
    return owner;
  };
  if (returnTo) {
    if (successor?.approved) throw new TypeError('choose an existing return recipient or a new successor');
    await observeParent();
    const recipient = await sessionAdapter.observe({ recipient: returnTo });
    if (recipient.sessionId !== returnTo.sessionId || recipient.incarnationId !== returnTo.incarnationId || recipient.cwd !== returnTo.cwd) throw new Error('return recipient mismatch');
    returnTo = recipient;
    if (owner.closable !== true || !owner.incarnationId || !owner.worker?.incarnationId) throw Object.assign(new Error('return requires a runtime-authorized closable worker'), { code: 'SESSION_OWNER_MISMATCH' });
  }
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
  const expected = effectArgsDigest({ policy, accepted: record.accepted, epoch: record.policyChanges?.at(-1)?.revision ?? 0, continuation: record.sameSessionContinuation ?? null });
  const delivered = await executeDelivery({ stateRoot, store, unit, requestedDelivery, delivery, adapters, expected });
  if (delivered.code !== 0) return delivered;
  record = await store.read(unit);
  const handoff = pendingFiles?.handoff ?? (successor?.approved ? await writeHandoff(stateRoot, unit, handoffContent) : null);
  const outcome = successor?.approved
    ? { kind: 'next', path: handoff.path, unit: lineValue(successor.unit, 'successor unit') }
    : goalComplete
      ? { kind: 'complete' }
      : sameSession ? { kind: 'continue', unit: sameSession.nextUnit } : null;
  if (!outcome) throw Object.assign(new Error('session finish requires an approved successor or confirmed goal completion'), { code: 'USER_DECISION_REQUIRED' });
  const resultContent = pendingFiles?.resultContent ?? formatUnitResult({ ...resultFields, outcome });
  const resultPath = pendingFiles?.resultPath ?? await writeUnitResult(stateRoot, unit, resultContent, { allowContinuing: Boolean(sameSession) });
  const resultDigest = pendingFiles?.resultDigest ?? `sha256:${createHash('sha256').update(await readFile(resultPath)).digest('hex')}`;
  if (!pendingFiles) await store.update(unit, current => ({
    ...current,
    result: resultContent,
    resultRef: { path: resultPath, digest: resultDigest },
    next: handoff ? { unit: successor.unit, handoff } : sameSession ? { unit: sameSession.nextUnit, sameSession: true } : null,
    ...(returnTo ? { sessionFinalization: { owner, recipient: returnTo, resultPath, resultDigest, sessionStart: null } } : {}),
  }));
  const prepareFinalization = async (recipient, sessionStart = null) => {
    if (!owner?.incarnationId || owner.closable !== true || !owner.worker?.incarnationId || owner.sessionId === recipient.sessionId) {
      return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, sessionId: recipient.sessionId, summary: 'A runtime-authorized closable worker owner is required' };
    }
    await store.update(unit, current => current.sessionFinalization ? current : ({ ...current, sessionFinalization: {
      owner, recipient, resultPath, resultDigest, ...(handoff ? { handoffPath: handoff.path, handoffDigest: handoff.digest } : {}), sessionStart,
    } }));
    return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, sessionId: recipient.sessionId, finalizePending: true,
      summary: 'Recipient task verified; result delivery and exact owner closure are pending' };
  };
  const projected = await projectTerminalUnit({
    store, unit, adapter: trackerAdapter, queue: createProjectionQueue(stateRoot, adapters), now: () => adapters.now(), git: adapters.git,
  });
  if (!projected.projected) return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, delivery: authorized, successor: null, ...(returnTo ? { finalizePending: true } : {}), summary: 'Final tracker projection is queued; successor session has not started' };
  if (!successor?.approved && !returnTo) {
    const closed = await commitTerminalClose({ store, unit, git: adapters.git });
    return { code: closed.state === 'Closed' ? 0 : 1, state: closed.state, resultPath, resultDigest, delivery: authorized, successor: null, summary: 'Unit completed' };
  }
  if (returnTo) return prepareFinalization(returnTo);
  const current = await store.read(unit);
  const preparation = prepareSuccessor({
    record: { ...current, tracker: current.tracker ? { ...current.tracker, projected: true } : null },
    handoff: handoffContent,
    successor: { ...successor, handoffPath: handoff.path, handoffDigest: handoff.digest }, parentSessionId,
  });

  const validateWorker = (result, input) => {
    if (typeof result?.sessionId !== 'string' || !result.sessionId || result.sessionId === parentSessionId
      || (result.cwd !== undefined && result.cwd !== successor.cwd)) {
      throw Object.assign(new Error('successor runtime identity or cwd is unverified'), { code: 'SESSION_OBSERVATION_INVALID' });
    }
    return validateTaskReceipt(result, input);
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
        return validateWorker(await sessionAdapter.execute(input), input);
      },
      async verify(input) {
        const verified = await sessionAdapter.verify(input);
        if (verified?.status === 'completed') {
          try { validateWorker(verified.result, input); } catch { return { status: 'unknown' }; }
        }
        return verified;
      },
    },
  });
  const startArgs = { unit: preparation.unit, role: successor.role ?? 'implementation', attempt: successor.attempt ?? 1, cwd: successor.cwd, handoffPath: handoff.path, handoffDigest: handoff.digest };
  try { validateWorker(started.result, { key: prepareEffect('session.start', startArgs).key, args: startArgs }); }
  catch { return { code: 3, state: 'Delivered', session: started, summary: 'Successor request/start receipt is missing or mismatched' }; }
  const sessionId = started.result?.sessionId;
  if (!['completed', 'duplicate', 'reconciled'].includes(started.status) || typeof sessionId !== 'string' || !sessionId || sessionId === parentSessionId
    || (started.result?.cwd !== undefined && started.result.cwd !== successor.cwd)) {
    return { code: 3, state: 'Delivered', resultPath, resultDigest, handoff, delivery: authorized, successor: preparation, session: started, summary: 'Successor session start is unresolved or did not create a new session' };
  }
  return prepareFinalization(started.result, started);
}

export async function finalizeSessionUnit({ stateRoot, store, unit, adapters }) {
  const record = await store.read(unit);
  const plan = record?.sessionFinalization;
  if (!plan || !['Delivered', 'Closed'].includes(record.state)) throw Object.assign(new Error('no durable session finalization plan'), { code: 'INVALID_TRANSITION' });
  await taskPackets(plan);
  if (record.state === 'Delivered') {
    const projection = await projectTerminalUnit({ store, unit, adapter: adapters.tracker, queue: createProjectionQueue(stateRoot, adapters), now: adapters.now, git: adapters.git });
    if (!projection.projected) return { code: 3, state: (await store.read(unit)).state, finalizePending: true, summary: 'Terminal tracker projection is pending' };
  }
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const ledger = createLedgerStore(stateRoot);
  const recipient = plan.recipient;
  const deliveryArgs = { ...plan, cwd: recipient.cwd, session: recipient.sessionId, incarnation: recipient.incarnationId };
  const delivered = await executeEffect({ unit, effect: 'session.deliver', args: deliveryArgs, policy,
    context: { explicitUserInstruction: true, productOwned: true }, store: ledger,
    adapter: { now: adapters.now, async execute(input) { return validateTaskReceipt(await adapters.session.execute(input), input); },
      async verify(input) {
        const value = await adapters.session.verify(input);
        if (value?.status === 'not-applied' && value.verify?.nativeRequestAbsent === true && value.verify.exactPendingComposer === true
          && value.result?.sessionId === recipient.sessionId && value.result.incarnationId === recipient.incarnationId
          && input.verificationCount + 1 < policy.retry.maxPerSignature) {
          return { status: 'completed', result: validateTaskReceipt(await adapters.session.execute(input), input) };
        }
        if (value?.status === 'completed') validateTaskReceipt(value.result, input);
        return value;
      } },
  });
  const pending = summary => ({ code: 3, state: record.state, summary, finalizePending: true });
  if (!['completed', 'reconciled', 'duplicate'].includes(delivered.status)) return pending('Result is queued or its acceptance/start is unverified');
  validateTaskReceipt(delivered.result, { args: deliveryArgs, key: prepareEffect('session.deliver', deliveryArgs).key });
  if (delivered.result.sessionId !== recipient.sessionId || delivered.result.incarnationId !== recipient.incarnationId) return pending('Result recipient identity changed');
  if (record.state !== 'Closed') {
    const current = await adapters.git.inspectUnit({ unit, record });
    if (current.head !== record.accepted.head || current.contentFingerprint !== record.accepted.contentFingerprint) return pending('Accepted content changed before session close');
  }
  const closeArgs = { owner: plan.owner, recipient, session: plan.owner.sessionId, incarnation: plan.owner.incarnationId,
    resultDigest: plan.resultDigest, deliveryKey: delivered.key };
  const validateClose = result => {
    if (result?.closed !== true || result.sessionId !== plan.owner.sessionId || result.incarnationId !== plan.owner.incarnationId) throw new Error('unverified close result');
    return result;
  };
  const closeEffect = { unit, effect: 'session.close', args: closeArgs, policy,
    context: { explicitUserInstruction: true, productOwned: true }, store: ledger,
    adapter: { now: adapters.now, async execute(input) { return validateClose(await adapters.session.execute(input)); },
      async verify(input) {
        const result = await adapters.session.verify(input);
        if (result?.status === 'not-applied' && result.result?.sessionId === plan.owner.sessionId
          && result.result.incarnationId === plan.owner.incarnationId && input.verificationCount + 1 < policy.retry.maxPerSignature) {
          return { status: 'completed', result: validateClose(await adapters.session.execute(input)) };
        }
        if (result?.status === 'completed') validateClose(result.result);
        return result;
      } },
  };
  let closed = await executeEffect(closeEffect);
  // The closing terminal may drop the command response. The survivor checks the same intent immediately.
  if (closed.status === 'uncertain') closed = await executeEffect(closeEffect);
  if (!['completed', 'reconciled', 'duplicate'].includes(closed.status) || closed.result?.closed !== true
    || closed.result.sessionId !== plan.owner.sessionId || closed.result.incarnationId !== plan.owner.incarnationId) return pending('Exact owner closure is unverified');
  const checked = await adapters.session.verify({ effect: 'session.close', args: closeArgs, key: closed.key, seq: closed.seq });
  if (checked?.status !== 'completed') return pending('Post-exit observation is unavailable');
  validateClose(checked.result);
  const current = record.state === 'Closed' ? record : await commitTerminalClose({ store, unit, git: adapters.git, sessionStart: plan.sessionStart, sessionClose: closed });
  return { code: current.state === 'Closed' ? 0 : 3, state: current.state, summary: 'Result accepted and owner session closure verified', resultPath: plan.resultPath };
}
