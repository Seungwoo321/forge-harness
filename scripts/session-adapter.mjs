import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionRunner } from './lib/session-runtime.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { selectExecutionPolicy } from './lib/continuity-decision.mjs';
import { goalOwner } from './lib/continuity-custody.mjs';
import { parseUnitArgs } from './lib/unit-driver.mjs';

// The durable request or finalization record identifies the owner; observations still fence it.
export async function createRuntimeAdapters({ cwd, adapters, options, argv }) {
  const {positional} = parseUnitArgs(argv);
  const unit = positional[positional[1] === 'stage' ? 3 : 2];
  if (!options['state-root'] || !unit) throw new TypeError('session adapter requires an explicit state root and unit');
  const stateRoot = path.resolve(cwd, options['state-root']);
  const request = options.request ? JSON.parse(await readFile(path.resolve(cwd, options.request),'utf8')) : null;
  const record = JSON.parse(await readFile(path.join(stateRoot,'units',unit,'unit.json'),'utf8'));
  const adopting = ['session-adopt','session-rebind'].includes(positional[1]);
  const goal = record.continuity?.goalId ? await createContinuityStore(stateRoot).read(record.continuity.goalId) : null;
  const role = record.kind === 'review' && positional[1] !== 'session-start' ? 'review' : 'implementation';
  const custody = record.kind === 'review' ? (positional[1] === 'session-start' ? goalOwner(goal,record.targetUnit) : goal?.reviews?.findLast(item=>item.unit === unit)) : goalOwner(goal,unit);
  const execution = goal ? selectExecutionPolicy(goal.policy,role) : null;
  const registeredOwner = custody?.owner ?? (custody && execution ? {...custody,runtime:execution.runtime,workerExecutable:execution.argv[0]} : null);
  const owner = adopting ? request?.owner : request?.parentRuntime ?? record.sessionFinalization?.owner ?? registeredOwner;
  const runtime = owner?.runtime;
  const executable = owner?.workerExecutable ?? owner?.worker?.executable;
  if (!['cmux','orca'].includes(runtime) || !owner?.sessionId || !owner.incarnationId || !path.isAbsolute(owner.cwd ?? '')
    || !['codex','claude'].includes(path.basename(executable ?? ''))) throw new TypeError('exact owner runtime and worker executable are required');
  const envFor = role => {
    if (!goal) return undefined;
    const policy = selectExecutionPolicy(goal.policy,role);
    return policy.provider === 'codex' ? {CODEX_HOME:policy.account} : {CLAUDE_CONFIG_DIR:policy.account};
  };
  const existing = adopting || custody?.ownership === 'existing' || record.sessionFinalization?.retainedOwner?.ownership === 'existing';
  const parent = {...owner,workerExecutable:executable,closable:!existing,
    workerEnv:owner.workerEnv ?? envFor(role),recipientEnv:owner.recipientEnv ?? envFor('implementation')};
  return {sessionRunner:createSessionRunner({runtime,command:adapters.command,parent,launch:()=>{throw new Error('goal-bound launch data is required');}})};
}
