import { prepareEffect, authorizeEffect, resolvePolicy } from './policy.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';
import { mkdir, open, readFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { effectArgsDigest as digest } from './approvals.mjs';
import { goalOwner, nativeOwner } from './continuity-custody.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { createUnitStateStore } from './unit-state.mjs';
import { createLedgerStore } from './ledger.mjs';

const fail = message => { throw Object.assign(new Error(message), {code:'WATCH_INVALID'}); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['.','..'].includes(value);
const terminal = watch => ['removed','retired','expired','exhausted'].includes(watch.status);
export const runnableWatches = watches => watches.some(watch => !terminal(watch) && watch.status !== 'paused' && watch.status !== 'HOLD');

export function createWatchStore(stateRoot, io) {
  const directory = path.resolve(stateRoot, 'watches');
  const file = path.join(directory, 'store.json');
  async function read() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.schema !== 'harness.watches/1' || !Array.isArray(value.watches)) fail('invalid watch store');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return {schema:'harness.watches/1',watches:[],runner:null}; throw error; }
  }
  async function save(value) {
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value,null,2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async function transaction(action) {
    await mkdir(directory, {recursive:true});
    const lock = await io.stateLock(path.join(directory,'.store.lock'), {wait:true});
    try { const data = await read(); return await action(data, async () => { lock.assertHeld(); await save(data); }); }
    finally { await lock.close(); }
  }
  return {directory,read,transaction};
}

// Lock order: watch store -> recipient -> effect ledger -> unit -> goal. No lifecycle writer takes a watch lock.
async function withBinding(stateRoot, watch, action) {
  const units = createUnitStateStore(stateRoot);
  return createLedgerStore(stateRoot).withLock(watch.unit, ledger => units.withLock(watch.unit, record =>
    createContinuityStore(stateRoot).transaction(watch.goalId, async goal => {
      const custody = goalOwner(goal,watch.unit);
      const valid = record?.continuity?.goalId === watch.goalId && ['active','blocked'].includes(goal?.goal.status)
        && goal.goal.remaining[0] === watch.unit && !['Closed','Stopped'].includes(record.state)
        && !record.sessionFinalization && (!watch.policyDigest || watch.policyDigest === digest(goal.policy)) && custody && digest(custody) === watch.custodyDigest;
      await action({valid,held:goal?.goal.status === 'blocked' || record.state === 'Blocked',record,goal,custody,ledger});
      return goal;
    })));
}

function assertWakePolicy(record) {
  const {policy} = resolvePolicy({project:record.policy ?? {},unit:record.policyOverrides ?? {}},{nonInteractive:true});
  const permission = authorizeEffect(policy,'session.wake',{explicitUserInstruction:true,inScope:true,productOwned:true});
  if (!permission.allowed) fail(permission.reason);
}

export async function registerWatch({stateRoot,request,io}) {
  if (!request || Object.keys(request).sort().join(',') !== ['id','unit','goalId','custodyDigest','recipient','account','everyMs','maxRuns','expiresAt','prompt','condition'].sort().join(',')
    || !/^sha256:[a-f0-9]{64}$/.test(request.custodyDigest ?? '') || !id(request.id) || !id(request.unit) || !id(request.goalId)
    || !Number.isSafeInteger(request.everyMs) || request.everyMs < 1000
    || !Number.isSafeInteger(request.maxRuns) || request.maxRuns < 1
    || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= io.nowMs()
    || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 1600
    || !Array.isArray(request.condition?.argv) || !request.condition.argv.length
    || request.condition.argv.some(value=>typeof value !== 'string' || !value)
    || !path.isAbsolute(request.condition.cwd ?? '') || !path.isAbsolute(request.account ?? '')) fail('exact watch request, finite expiry/budget and mechanical condition are required');
  const recipient = nativeOwner(request.recipient);
  if (digest(recipient) !== digest(request.recipient)) fail('exact native recipient fields are required');
  const backend = io.backendFor(recipient);
  if (typeof backend !== 'string' || !backend) fail('verified watch backend is required');
  const watch = {...request,externalRoots:[...(io.externalRoots ?? [])],stateRoot:path.resolve(stateRoot),recipient,backend,status:'active',runs:0,attempts:[],nextDue:io.nowMs()+request.everyMs};
  return createWatchStore(stateRoot,io).transaction(async (data,save) => {
    if (data.watches.some(item=>item.id === watch.id)) fail('watch id already exists; history cannot be replaced');
    if (data.watches.some(item=>(!terminal(item) || item.pending) && item.account === watch.account && item.recipient.worker.threadId === recipient.worker.threadId)) fail('recipient already has a watch');
    await io.assertExclusive(watch);
    await io.withReceiver(watch,async () => withBinding(stateRoot,watch,async ({valid,held,custody,goal,record}) => {
      if (!valid || held || path.resolve(selectExecutionPolicy(goal.policy,'implementation').account) !== watch.account || digest(nativeOwner(custody.owner ?? custody)) !== digest(recipient)) fail('watch must bind current exact custody');
      assertWakePolicy(record);
      watch.policyDigest = digest(goal.policy);
      await io.observe(watch);
      watch.lastState = digest((await io.condition(watch)).state);
      await io.claimReceiver(watch);
      data.watches.push(watch); await save();
    }));
    return watch;
  });
}

export async function changeWatch({stateRoot,id:watchId,action,io}) {
  return createWatchStore(stateRoot,io).transaction(async (data,save) => {
    const watch = data.watches.find(item=>item.id === watchId);
    if (!watch) fail('watch not found');
    if (action === 'remove') watch.status = 'removed';
    else if (['pause','hold'].includes(action)) { if (terminal(watch)) fail('watch is retired'); watch.status = action === 'pause' ? 'paused' : 'HOLD'; }
    else if (action === 'resume') { if (terminal(watch)) fail('watch is retired'); watch.status = 'active'; }
    else if (action !== 'reconcile') fail('unsupported watch action');
    // Reconciliation only observes the original attempt, including while paused. Never resend.
    if (action === 'reconcile' && watch.pending) await io.withReceiver(watch,()=>createLedgerStore(stateRoot).withLock(watch.unit,ledger=>reconcile(watch,io,ledger)));
    await save(); return watch;
  });
}

async function reconcile(watch,io,ledger) {
  const attempt = watch.attempts.find(item=>item.key === watch.pending);
  const observation = await io.receipt(watch,attempt);
  if (['queued','accepted','started'].includes(observation.state)) {
    attempt.transportAccepted = true;
    attempt.observation = observation;
    attempt.status = observation.state === 'started' ? 'turn-started' : 'transport-accepted';
    if (observation.state === 'started') {
      const rows = await ledger.read();
      if (rows.some(row=>row.event === 'intent' && row.key === attempt.key && row.seq === attempt.seq)
        && !rows.some(row=>row.event === 'result' && row.key === attempt.key && row.seq === attempt.seq))
        await ledger.append({event:'result',unit:watch.unit,key:attempt.key,seq:attempt.seq,result:{status:'completed',nativeTurn:observation},done_at:new Date(io.nowMs()).toISOString()});
    }
    if (observation.state === 'started' && ['completed','failed','interrupted'].includes(observation.turnStatus)) {
      // A terminal native turn is evidence about that turn, not goal/unit completion.
      attempt.result = {turnStatus:observation.turnStatus,turnId:observation.turnId};
      attempt.status = 'result'; delete watch.pending;
    }
  } else attempt.status = 'uncertain';
}

export async function tickWatches({stateRoot,io}) {
  return createWatchStore(stateRoot,io).transaction(async (data,save) => {
    for (const watch of data.watches) {
      if (terminal(watch)) continue;
      if (io.nowMs() >= watch.expiresAt) { watch.status = 'expired'; continue; }
      if (['paused','HOLD'].includes(watch.status)) continue;
      try {
        await io.withReceiver(watch,async () => {
          if (watch.pending) {
            await createLedgerStore(stateRoot).withLock(watch.unit,ledger=>reconcile(watch,io,ledger));
            return;
          }
          return withBinding(stateRoot,watch,async ({valid,held,ledger,record}) => {
            if (!valid) { watch.status = 'retired'; return; }
            if (held) { watch.status = 'HOLD'; return; }
            if (watch.runs >= watch.maxRuns) { watch.status = 'exhausted'; return; }
            const now = io.nowMs();
            if (now < watch.nextDue) return;
            // Coalesce missed occurrences instead of replaying a backlog after sleep/restart.
            watch.nextDue = now + watch.everyMs;
            const condition = await io.condition(watch), state = digest(condition.state);
            if (state === watch.lastState) return;
            if (!condition.actionable) { watch.lastState = state; return; }
            if (io.backendFor(watch.recipient) !== watch.backend) fail('watch backend changed; explicit reconciliation is required');
            await io.assertExclusive(watch);
            const observed = await io.observe(watch);
            if (!observed.ready) return;
            assertWakePolicy(record);
            const args = {watchId:watch.id,stateRoot:watch.stateRoot,custodyDigest:watch.custodyDigest,conditionDigest:state,run:watch.runs+1,recipient:watch.recipient,goalId:watch.goalId};
            const {key} = prepareEffect('session.wake',args);
            const rows = await ledger.read();
            const seq = rows.reduce((max,row)=>Math.max(max,Number.isSafeInteger(row.seq) ? row.seq : 0),0)+1;
            const attempt = {key,seq,state,status:'intent',submitted:false,transportAccepted:false,at:now};
            watch.runs += 1; watch.pending = key; watch.lastState = state; watch.attempts.push(attempt);
            // Claim budget and intent durably before crossing the external submission boundary.
            await save();
            await ledger.append({event:'intent',unit:watch.unit,effect:'session.wake',class:'E3',seq,key,args,intent_at:new Date(now).toISOString(),approvalRef:`watch:${watch.id}`,compensate:null});
            attempt.submitted = true; attempt.status = 'submitted'; await save();
            await io.submit(watch,attempt);
            attempt.transportAccepted = true; attempt.status = 'transport-accepted'; await save();
            await reconcile(watch,io,ledger);
          });
        });
        delete watch.error;
      } catch (error) {
        watch.error = {code:error.code ?? 'WATCH_OBSERVATION_FAILED',message:error.message};
        if (watch.pending) watch.attempts.find(item=>item.key === watch.pending).status = 'uncertain';
      }
      await save();
    }
    await save(); return data;
  });
}

export async function cleanupWatches({stateRoot,unit,recipient,io}) {
  try { await readFile(path.join(stateRoot,'watches','store.json')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  return createWatchStore(stateRoot,io).transaction(async (data,save) => {
    for (const watch of data.watches) if (watch.unit === unit && digest(watch.recipient) === digest(nativeOwner(recipient))) watch.status = 'removed';
    await save();
  });
}

export async function externalWatchConflict(roots, watch) {
  for (const root of roots) {
    let entries;
    try { entries = await readdir(path.join(root,'schedules')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of entries.filter(name=>name.endsWith('.json'))) {
      const schedule = JSON.parse(await readFile(path.join(root,'schedules',file),'utf8'));
      const target = schedule.target;
      if (target?.type === 'codex-queue' && target.thread === watch.recipient.worker.threadId && path.resolve(target.home) === watch.account) fail('external scheduler owns this recipient; explicit offline migration is required');
      if (target?.type === 'cmux' && watch.recipient.runtime === 'cmux' && target.surface === watch.recipient.sessionId) fail('external terminal scheduler owns this recipient');
    }
  }
}
