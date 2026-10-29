import { open, mkdir, readFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { authorizeEffect, effectDefinition, prepareEffect } from './policy.mjs';

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
  const verify = async input => {
    try { return await adapter.verify(input); }
    catch { return { status: 'unknown', verify: null }; }
  };

  return await store.withLock(unit, async ledger => {
    const records = await ledger.read();
    const intents = records.filter(row => row.event === 'intent' && row.key === prepared.key);
    const priorIntent = intents.at(-1);
    if (priorIntent) {
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
        const verification = await verify({ effect, args: priorIntent.args, key: priorIntent.key, seq: priorIntent.seq });
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
    await ledger.append(intent);
    try {
      const result = await adapter.execute({ effect, args, key: prepared.key, seq });
      const doneAt = adapter.now();
      await ledger.append({ event: 'result', unit, seq, key: prepared.key, result, done_at: doneAt, verify: result?.verify ?? null });
      return { status: 'completed', key: prepared.key, result, seq };
    } catch {
      return { status: 'uncertain', key: prepared.key, seq, verification: null };
    }
  });
}
