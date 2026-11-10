import { open, mkdir, readFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { authorizeEffect, effectDefinition, prepareEffect } from './policy.mjs';
import { effectArgsDigest } from './approvals.mjs';

function unitPathPart(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '.' || unit === '..') {
    throw new TypeError('unit must be a path-safe identifier');
  }
  return unit;
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function matchingOpenPr(verification, args) {
  return verification?.status === 'open'
    && ['repo', 'branch', 'head', 'base'].every(field => verification[field] === args[field]);
}

function parseLedger(text) {
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (cause) {
      const error = new Error(`invalid ledger record at line ${index + 1}`, { cause });
      error.code = 'LEDGER_CORRUPT';
      throw error;
    }
  });
}

async function waitForLock(file) {
  let content;
  try { content = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let owner;
  try { owner = JSON.parse(content).pid; } catch { owner = null; }
  if (!Number.isSafeInteger(owner) || owner < 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    return;
  }
  try { process.kill(owner, 0); } catch (error) {
    if (error.code === 'ESRCH') throw errorWithCode('LEDGER_LOCK_ORPHANED', `ledger lock owner exited: ${owner}`);
    if (error.code !== 'EPERM') throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}

export function createLedgerStore(stateRoot) {
  const root = path.resolve(stateRoot);
  function filesFor(unit) {
    const name = unitPathPart(unit);
    const dir = path.join(root, 'units', name);
    return { dir, ledger: path.join(dir, 'ledger.ndjson'), lock: path.join(dir, '.ledger.lock') };
  }

  async function withLock(unit, action) {
    const files = filesFor(unit);
    await mkdir(files.dir, { recursive: true });
    let lock;
    while (!lock) {
      try { lock = await open(files.lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await waitForLock(files.lock);
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      return await action({
        async read() {
          try { return parseLedger(await readFile(files.ledger, 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        },
        async append(record) {
          await appendFile(files.ledger, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
          const handle = await open(files.ledger, 'r+');
          try { await handle.sync(); } finally { await handle.close(); }
        },
      });
    } finally {
      await lock.close();
      await rm(files.lock, { force: true });
    }
  }

  return Object.freeze({ withLock });
}

export function sessionEffectRetired(records, intent) {
  return records.some(row => (intent.effect === 'session.start' && row.event === 'session-start-recovery'
    || intent.effect === 'session.deliver' && row.event === 'delivered-rework'
    || intent.effect === 'session.close' && row.event === 'goal-completion-recovery')
    && row.seq === intent.seq && row.key === intent.key && row.intentDigest === effectArgsDigest(intent));
}

export async function executeEffect({
  unit,
  effect,
  args,
  policy,
  context = {},
  approvalRef = null,
  store,
  adapter,
  retryResolved,
}) {
  unitPathPart(unit);
  const definition = effectDefinition(effect);
  if (!store || typeof store.withLock !== 'function') throw new TypeError('ledger store must implement withLock');
  if (!adapter || typeof adapter.execute !== 'function' || typeof adapter.verify !== 'function'
    || typeof adapter.now !== 'function') {
    throw new TypeError('effect adapter must implement execute, verify, and now');
  }
  const prepared = prepareEffect(effect, args);
  const effectClass = context.irreversible === true ? 'E4' : definition.class;
  const authorization = authorizeEffect(policy, effect, {
    ...context,
    explicitUserInstruction: context.explicitUserInstruction === true,
  });
  if (!authorization.allowed) throw errorWithCode('EFFECT_DENIED', authorization.reason);
  if (effectClass === 'E4' && !approvalRef && context.productOwned !== true) {
    throw errorWithCode('EFFECT_APPROVAL_REQUIRED', 'E4 effect requires an approval reference');
  }
  return await store.withLock(unit, async ledger => {
    const submissionInput = async (input, recovery) => {
      const goalStart = effect === 'session.start' && input.args.goalPath;
      if (!goalStart && effect !== 'session.deliver') return input;
      const rows = await ledger.read();
      const previous = rows.findLast(row => row.event === 'submission' && row.seq === input.seq && row.key === input.key);
      const readOnly = rows.some(row => row.event === 'result' && row.seq === input.seq && row.key === input.key);
      const belongs = row => row.seq === input.seq && row.key === input.key;
      const repairIndex = rows.findLastIndex(row => belongs(row) && row.event === 'draft-repair');
      const priorRepair = rows[repairIndex];
      const recoverClear = priorRepair?.correction?.route === undefined && priorRepair?.correction?.kind === 'first-burst-slash-loss'
        && effectArgsDigest(priorRepair.binding) === effectArgsDigest(previous?.binding)
        && rows.slice(repairIndex + 1).some(row => belongs(row) && row.event === 'verification' && row.verify?.code === 'SESSION_TASK_UNVERIFIED' && row.verify.message === 'native goal composer contains another draft')
        && !rows.some(row => belongs(row) && row.event === 'draft-clear-recovery');
      const submission = {attempted:Boolean(previous),binding:previous?.binding,recovery,readOnly,
        pendingDraft:rows.some(row => belongs(row) && row.event === 'verification' && row.verify?.code === 'SESSION_TASK_UNVERIFIED' && row.verify.message === 'native goal composer did not settle'),
        repairAttempted:rows.some(row => belongs(row) && row.event === 'draft-repair'),
        recoverClear,
        confirmed:rows.some(row => belongs(row) && row.event === 'confirmation'),
        async repair(binding,correction) {
          if (correction?.kind !== 'first-burst-slash-loss' || correction.route !== 'codex-cancel/1' || !/^sha256:[a-f0-9]{64}$/.test(correction.fromDigest ?? '') || !/^sha256:[a-f0-9]{64}$/.test(correction.toDigest ?? '')) throw errorWithCode('LEDGER_VERIFY_INVALID','native draft correction binding is incomplete');
          if (submission.repairAttempted && (!submission.recoverClear || correction.fromDigest !== priorRepair.correction.fromDigest || correction.toDigest !== priorRepair.correction.toDigest)) throw errorWithCode('EFFECT_UNCERTAIN','legacy native clear recovery is unverified');
          await checkpoint(submission.repairAttempted ? 'draft-clear-recovery' : 'draft-repair',binding,correction);
        },
        async confirm(binding) { await checkpoint('confirmation',binding); },
        async mark(binding) {
          if (submission.readOnly || submission.attempted || (await ledger.read()).some(row => row.event === 'submission' && row.seq === input.seq && row.key === input.key))
            throw errorWithCode('EFFECT_UNCERTAIN',goalStart ? 'native goal input was already attempted' : 'native result input was already attempted');
          const packets = ['handoff','result','goal'].filter(name=>input.args[`${name}Path`] !== undefined).map(name=>({path:input.args[`${name}Path`],digest:input.args[`${name}Digest`]}));
          if (!binding || !['cmux','orca'].includes(binding.runtime) || !Number.isSafeInteger(binding.pid) || binding.pid < 1 || !binding.executable
            || effectArgsDigest(binding.packets) !== effectArgsDigest(packets) || binding.cwd !== input.args.cwd || binding.goalDigest !== input.args.goalDigest
            || !binding.threadId || !binding.sessionId || !binding.incarnationId || !binding.promptDigest || !Array.isArray(binding.packets)
            || !goalStart && (!input.args.recipient || binding.sessionId !== input.args.recipient.sessionId
              || binding.incarnationId !== input.args.recipient.incarnationId || binding.cwd !== input.args.recipient.cwd
              || input.args.recipient.worker?.threadId && binding.threadId !== input.args.recipient.worker.threadId))
            throw errorWithCode('LEDGER_VERIFY_INVALID',goalStart ? 'native goal submission binding is incomplete' : 'native result submission binding is incomplete');
          await ledger.append({event:'submission',unit,effect,seq:input.seq,key:input.key,binding:structuredClone(binding),attempted_at:adapter.now()});
          submission.attempted = true; submission.binding = structuredClone(binding);
        }};
      async function checkpoint(event,binding,correction) {
        if (submission.readOnly || !submission.attempted || submission.confirmed
          || effectArgsDigest(binding) !== effectArgsDigest(submission.binding)
          || event === 'draft-repair' && (!submission.pendingDraft || submission.repairAttempted)
          || event === 'draft-clear-recovery' && !submission.recoverClear
          || (await ledger.read()).some(row => belongs(row) && row.event === event)) throw errorWithCode('EFFECT_UNCERTAIN','native draft edit or Return was already attempted or is unverified');
        await ledger.append({event,unit,effect,seq:input.seq,key:input.key,binding:structuredClone(binding),...(correction?{correction:structuredClone(correction)}:{}),attempted_at:adapter.now()});
        if (event === 'draft-repair') submission.repairAttempted = true;
        else if (event === 'draft-clear-recovery') submission.recoverClear = false;
        else submission.confirmed = true;
      }
      return {...input,submission};
    };
    const verify = async input => {
      if (ledger.assertEffect) await ledger.assertEffect({effect,key:prepared.key,phase:'verify'});
      try { return await adapter.verify(await submissionInput({...input,...(ledger.reconcileOnly?{reconcileOnly:true}:{})},true)); }
      catch (error) { return {status:'unknown',verify:effect === 'session.deliver' || effect === 'session.start' && input.args.goalPath ? {code:error.code ?? 'SESSION_OBSERVATION_INVALID',message:error.message} : null}; }
    };
    const perform = async ({completedOnly = false} = {}) => {
    const records = await ledger.read();
    if (['session.deliver','session.close'].includes(effect)) {
      const rework=records.findLast(row=>row.event==='delivered-rework');
      const recovery=records.findLast(row=>row.event==='goal-completion-recovery');
      const epoch=rework || recovery ? effectArgsDigest({rework:rework?.requestDigest ?? null,recovery:recovery?.requestDigest ?? null}) : undefined;
      if (args.recoveryEpoch!==epoch) throw errorWithCode('EFFECT_RETIRED','session effect does not match its verified recovery epoch');
    }
    const intents = records.filter(row => row.event === 'intent' && row.key === prepared.key);
    const priorIntent = intents.at(-1);
    if (completedOnly && (!priorIntent || !records.some(row=>row.event==='result' && row.seq===priorIntent.seq
      && row.key===priorIntent.key && (effect==='session.close' ? row.result?.closed===true : effect==='session.deliver' && row.result?.task))))
      throw errorWithCode('EFFECT_UNCERTAIN','completed goal requires its existing exact session receipt');
    if (priorIntent && sessionEffectRetired(records, priorIntent))
      throw errorWithCode('EFFECT_RETIRED', 'session effect was retired by verified recovery');
    if (priorIntent) {
      if (effect === 'session.start' && effectArgsDigest(priorIntent.args) !== effectArgsDigest(args))
        throw errorWithCode('EFFECT_UNCERTAIN', 'session start requires its original complete arguments');
      const result = records.findLast(row => row.event === 'result' && row.seq === priorIntent.seq);
      let closedPr = false;
      let retry = false;
      if (effectClass !== 'E4' && result?.result?.status === 'not-applied' && typeof retryResolved === 'function') {
        const checked = await verify({ effect, args: priorIntent.args, key: priorIntent.key, seq: priorIntent.seq, priorResult: result.result });
        await ledger.append({ event: 'verification', unit, seq: priorIntent.seq, key: prepared.key,
          status: checked?.status ?? 'unknown', verify: checked?.verify ?? null, checked_at: adapter.now() });
        retry = checked?.status === 'not-applied' && checked.verify != null
          && await retryResolved({ intent: priorIntent, result: result.result });
        if (!retry) return { status: 'uncertain', key: prepared.key, seq: priorIntent.seq, verification: checked?.verify ?? null };
      }
      if (result && effect === 'session.start' && !retry) {
        const checked = await verify({ effect, args: priorIntent.args, key: priorIntent.key, seq: priorIntent.seq, priorResult: result.result });
        if (checked?.status !== 'completed' || !Object.hasOwn(checked, 'result')) {
          await ledger.append({ event: 'verification', unit, seq: priorIntent.seq, key: prepared.key,
            status: checked?.status ?? 'unknown', verify: checked?.verify ?? null, checked_at: adapter.now() });
          return { status: 'uncertain', key: prepared.key, seq: priorIntent.seq, verification: checked?.verify ?? null };
        }
        const changed = JSON.stringify(checked.result) !== JSON.stringify(result.result);
        if (changed) await ledger.append({ event: 'result', unit, seq: priorIntent.seq, key: prepared.key,
          result: checked.result, done_at: adapter.now(), verify: checked.verify ?? null });
        return { status: changed ? 'reconciled' : 'duplicate', key: prepared.key, result: checked.result, seq: priorIntent.seq };
      }
      if (result && effect !== 'pr.create' && !retry) return { status: 'duplicate', key: prepared.key, result: result.result, seq: result.seq };
      if (result && effect === 'pr.create' && !retry) {
        const verification = await verify({ effect, args, key: priorIntent.key, seq: priorIntent.seq, priorResult: result.result });
        if (matchingOpenPr(verification, args) && verification.result?.pr) {
          const replaced = verification.result.pr !== result.result?.pr;
          if (replaced) await ledger.append({ event: 'result', unit, seq: priorIntent.seq, key: prepared.key,
            result: verification.result, done_at: adapter.now(), verify: verification.verify ?? null });
          return { status: replaced ? 'reconciled' : 'duplicate', key: prepared.key, result: verification.result, seq: result.seq };
        }
        if (!['closed', 'merged', 'not-found'].includes(verification?.status)) {
          return { status: 'uncertain', key: prepared.key, seq: priorIntent.seq, verification: verification?.verify ?? null };
        }
        closedPr = true;
      }
      if (!retry && (!result || !closedPr)) {
        const verification = await verify({ effect, args: priorIntent.args, key: priorIntent.key, seq: priorIntent.seq,
          verificationCount: records.filter(row => row.event === 'verification' && row.seq === priorIntent.seq).length });
        if (verification?.status === 'completed' && effect !== 'pr.create'
          || effect === 'pr.create' && matchingOpenPr(verification, priorIntent.args)) {
          if (!Object.hasOwn(verification, 'result')) throw errorWithCode('LEDGER_VERIFY_INVALID', 'completed verification requires a result');
          const confirmed = {
            event: 'result', unit, seq: priorIntent.seq, key: prepared.key,
            result: verification.result, done_at: adapter.now(), verify: verification.verify ?? null,
          };
          await ledger.append(confirmed);
          return { status: 'reconciled', key: prepared.key, result: confirmed.result, seq: confirmed.seq };
        }
        const closed = effect === 'pr.create' && ['closed', 'merged'].includes(verification?.status)
          && verification.verify != null && verification.result?.pr
          && ['repo', 'branch', 'head', 'base'].every(field => verification[field] === priorIntent.args[field]);
        if (closed) {
          await ledger.append({ event: 'result', unit, seq: priorIntent.seq, key: prepared.key,
            result: { ...verification.result, status: verification.status }, done_at: adapter.now(), verify: verification.verify });
        } else {
          await ledger.append({ event: 'verification', unit, seq: priorIntent.seq, key: prepared.key,
            status: verification?.status ?? 'unknown', verify: verification?.verify ?? null, checked_at: adapter.now() });
          return { status: 'uncertain', key: prepared.key, seq: priorIntent.seq, verification: verification?.verify ?? null };
        }
      }
    }

    const seq = records.reduce((max, row) => Math.max(max, Number.isSafeInteger(row.seq) ? row.seq : 0), 0) + 1;
    const intent = {
      event: 'intent', unit, seq, class: effectClass, effect, key: prepared.key,
      args, intent_at: adapter.now(), approvalRef, compensate: null,
    };
    if (ledger.assertEffect) await ledger.assertEffect({effect,key:prepared.key,phase:'execute'});
    await ledger.append(intent);
    try {
      const result = await adapter.execute(await submissionInput({ effect, args, key: prepared.key, seq },false));
      const doneAt = adapter.now();
      await ledger.append({ event: 'result', unit, seq, key: prepared.key, result, done_at: doneAt, verify: result?.verify ?? null });
      return { status: 'completed', key: prepared.key, result, seq };
    } catch {
      return { status: 'uncertain', key: prepared.key, seq, verification: null };
    }
    };
    return typeof adapter.fence === 'function' ? adapter.fence(perform) : perform();
  });
}
