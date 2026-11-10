import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionRunner } from './lib/session-runtime.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { selectExecutionPolicy } from './lib/continuity-decision.mjs';
import { goalOwner } from './lib/continuity-custody.mjs';
import { parseUnitArgs } from './lib/unit-driver.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { loadManagedLaunch } from './lib/continuity-launch-io.mjs';
import { taskPackets } from './lib/session-task.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';

// The durable request or finalization record identifies the owner; observations still fence it.
export async function createRuntimeAdapters({ cwd, adapters, options, argv }) {
  const {positional} = parseUnitArgs(argv);
  const request = options.request ? JSON.parse(await readFile(path.resolve(cwd, options.request),'utf8')) : null;
  const unit = positional[0] === 'goal' && positional[1] === 'policy-recover' ? request?.unit : positional[positional[1] === 'stage' ? 3 : 2];
  if (!options['state-root'] || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit ?? '') || ['.','..'].includes(unit)) throw new TypeError('session adapter requires an explicit state root and unit');
  const stateRoot = path.resolve(cwd, options['state-root']);
  const record = JSON.parse(await readFile(path.join(stateRoot,'units',unit,'unit.json'),'utf8'));
  const adopting = ['session-adopt','session-rebind','delivered-continue'].includes(positional[1]);
  const goal = record.continuity?.goalId ? await createContinuityStore(stateRoot).read(record.continuity.goalId) : null;
  let observationPolicy = goal?.policy;
  if (positional[1] === 'session-start' && goal) {
    const rows = await createLedgerStore(stateRoot).withLock(unit,ledger=>ledger.read());
    const recovery = rows.findLast(row=>row.event === 'session-start-recovery');
    const historyLength = record.sessionHistory?.length ?? 0;
    const attempt = Math.max(historyLength+1,recovery ? recovery.nextArgs.attempt+historyLength-recovery.sessionHistoryLength : 1);
    const args = rows.findLast(row=>row.event === 'intent' && row.effect === 'session.start' && row.args?.attempt === attempt)?.args
      ?? (recovery?.nextArgs.attempt === attempt ? recovery.nextArgs : null);
    if (args) {
      await loadManagedLaunch(args);
      observationPolicy = JSON.parse(await readFile(args.goalPath,'utf8')).policy;
    }
  }
  const role = record.kind === 'review' && positional[1] !== 'session-start' ? 'review' : 'implementation';
  const custody = record.kind === 'review' ? (positional[1] === 'session-start' ? goalOwner(goal,record.targetUnit) : goal?.reviews?.findLast(item=>item.unit === unit)) : goalOwner(goal,unit);
  const custodyPolicy = async custody => {
    if (custody?.policyDigest) {
      const policy = [goal?.policy,...(goal?.policyChanges ?? []).map(change=>change.previous)].find(policy=>policy && effectArgsDigest(policy) === custody.policyDigest);
      if (!policy) throw new TypeError('registered owner execution policy is unavailable');
      return policy;
    }
    if (!custody?.goalPath) return goal?.policy;
    const packets = await taskPackets({goalPath:custody.goalPath,goalDigest:custody.goalDigest});
    return JSON.parse(packets[0].content).policy;
  };
  if (!adopting && (custody?.goalPath || custody?.policyDigest)) observationPolicy = await custodyPolicy(custody);
  const recipientPolicy = record.kind === 'review' ? await custodyPolicy(goalOwner(goal,record.targetUnit)) : observationPolicy;
  const execution = observationPolicy ? selectExecutionPolicy(observationPolicy,role) : null;
  const registeredOwner = custody?.owner ?? (custody && execution ? {...custody,runtime:execution.runtime,workerExecutable:execution.argv[0]} : null);
  const owner = adopting ? request?.owner : request?.parentRuntime ?? record.sessionFinalization?.owner ?? registeredOwner;
  const runtime = owner?.runtime;
  const executable = owner?.workerExecutable ?? owner?.worker?.executable;
  if (!['cmux','orca'].includes(runtime) || !owner?.sessionId || !owner.incarnationId || !path.isAbsolute(owner.cwd ?? '')
    || !['codex','claude'].includes(path.basename(executable ?? ''))) throw new TypeError('exact owner runtime and worker executable are required');
  const envFor = (role, source = observationPolicy) => {
    if (!source) return undefined;
    const policy = selectExecutionPolicy(source,role);
    return policy.provider === 'codex' ? {CODEX_HOME:policy.account} : {CLAUDE_CONFIG_DIR:policy.account};
  };
  const existing = adopting || custody?.ownership === 'existing' || record.sessionFinalization?.retainedOwner?.ownership === 'existing';
  const parent = {...owner,workerExecutable:executable,closable:!existing,
    workerEnv:owner.workerEnv ?? envFor(role),recipientEnv:owner.recipientEnv ?? envFor('implementation',recipientPolicy)};
  return {sessionRunner:createSessionRunner({runtime,command:adapters.command,parent,launch:()=>{throw new Error('goal-bound launch data is required');}})};
}
