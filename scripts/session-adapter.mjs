import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionRunner } from './lib/session-runtime.mjs';

// The durable request or finalization record identifies the owner; observations still fence it.
export async function createRuntimeAdapters({ cwd, adapters, options, argv }) {
  if (!options['state-root'] || !argv[2]) throw new TypeError('session adapter requires an explicit state root and unit');
  const stateRoot = path.resolve(cwd, options['state-root']);
  const request = options.request ? JSON.parse(await readFile(path.resolve(cwd, options.request),'utf8')) : null;
  const record = JSON.parse(await readFile(path.join(stateRoot,'units',argv[2],'unit.json'),'utf8'));
  const owner = request?.parentRuntime ?? record.sessionFinalization?.owner;
  const runtime = owner?.runtime;
  const executable = owner?.workerExecutable ?? owner?.worker?.executable;
  if (!['cmux','orca'].includes(runtime) || !owner?.sessionId || !owner.incarnationId || !path.isAbsolute(owner.cwd ?? '')
    || !['codex','claude'].includes(path.basename(executable ?? ''))) throw new TypeError('exact owner runtime and worker executable are required');
  const parent = {...owner,workerExecutable:executable,closable:true};
  return {sessionRunner:createSessionRunner({runtime,command:adapters.command,parent,launch:()=>{throw new Error('goal-bound launch data is required');}})};
}
