import { mkdir, readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapters } from './adapters.mjs';
import { createSessionRunner } from './session-runtime.mjs';
import { createCodexTaskTransport } from './codex-task.mjs';
import { nativeOwner } from './continuity-custody.mjs';
import { effectArgsDigest } from './approvals.mjs';
import { codexComposerEmpty, codexComposerWorking } from './codex-composer.mjs';
import { orcaGoalScreen } from './orca-goal-screen.mjs';
import { externalWatchConflict } from './lifecycle-watch.mjs';

export function createWatchIO({core = createAdapters(), env = process.env} = {}) {
  // Every external command, including condition probes, goes through the existing adapter.
  const externalRoots = [...new Set([path.join(os.homedir(),'.local','state','agent-scheduler'),...(env.AGENT_SCHEDULER_HOME ? [path.resolve(env.AGENT_SCHEDULER_HOME)] : [])])];
  const command = (binary,args,options={}) => core.command(binary,args,{...options,signal:AbortSignal.timeout(15000)});
  const transport = watch => createCodexTaskTransport({command,executable:watch.recipient.worker.executable,env:{...env,CODEX_HOME:watch.account}});
  const prompt = (watch,attempt) => `${watch.prompt} [watch ${attempt.key}]`;
  const request = (watch,attempt,observed) => ({observed,input:{effect:'session.deliver',key:attempt.key},prompt:prompt(watch,attempt),packets:[],requireIdle:true,fence:watch.recipient.worker.threadId});
  async function inspect(watch) {
    const owner = watch.recipient;
    const runner = createSessionRunner({runtime:owner.runtime,command,parent:{sessionId:'watch-observer',incarnationId:'watch-observer',cwd:owner.cwd,recipientEnv:{...env,CODEX_HOME:watch.account}},launch:()=>{throw new Error('watch cannot launch replacement owners');}});
    const observed = await runner.observe({recipient:{...owner,executable:owner.worker.executable},nativeOwner:true});
    if (effectArgsDigest(nativeOwner(observed)) !== effectArgsDigest(owner)) throw new Error('watch recipient identity changed');
    return observed;
  }
  async function ready(watch,attempt={key:'readiness'}) {
    const observed = await inspect(watch);
    const nativeTransport = transport(watch);
    await nativeTransport.preflight({cwd:observed.cwd});
    const native = await nativeTransport.observe(request(watch,attempt,observed));
    let screen;
    if (watch.recipient.runtime === 'cmux') {
      const result = await command('cmux',['read-screen','--workspace',observed.workspaceId,'--surface',observed.sessionId],{cwd:observed.cwd});
      if (result.exitCode !== 0 || result.signal) throw new Error('recipient screen unavailable');
      screen = result.stdout;
    } else {
      const result = await command('orca',['terminal','read','--terminal',observed.sessionId,'--screen','--json'],{cwd:observed.cwd});
      if (result.exitCode !== 0 || result.signal) throw new Error('recipient screen unavailable');
      const response = JSON.parse(result.stdout);
      const rendered = orcaGoalScreen((response.result ?? response).terminal,observed.sessionId,true);
      if (rendered.renderedDraft !== '') throw new Error('native composer contains a draft or cannot be verified');
      screen = rendered.screen;
    }
    return {observed,ready:native.state === 'ready' && native.queueLength === 0 && !native.active && !codexComposerWorking(screen) && codexComposerEmpty(screen)};
  }
  return {
    ...core,externalRoots,
    backendFor(recipient) {
      if (path.basename(recipient.worker.executable) !== 'codex') throw new Error('only the verified Codex native queue backend is supported');
      return 'codex-native-queue/1';
    },
    host:()=>os.hostname(),nowMs:()=>Date.parse(core.now()),
    async withReceiver(watch,action) {
      const directory = path.join(watch.account,'lifecycle-watches');
      await mkdir(directory,{recursive:true});
      const lock = await core.stateLock(path.join(directory,`${effectArgsDigest(watch.recipient.worker.threadId).slice(7)}.lock`),{wait:true});
      try { return await action(); } finally { await lock.close(); }
    },
    async claimReceiver(watch) {
      const directory = path.join(watch.account,'lifecycle-watches');
      const file = path.join(directory,`${effectArgsDigest(watch.recipient.worker.threadId).slice(7)}.json`);
      let previous;
      try { previous = JSON.parse(await readFile(file,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous && (previous.stateRoot !== watch.stateRoot || previous.id !== watch.id)) {
        let data;
        try { data = JSON.parse(await readFile(path.join(previous.stateRoot,'watches','store.json'),'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const owner = data?.watches?.find(item=>item.id === previous.id);
        if (owner && (owner.pending || !['removed','retired','expired','exhausted'].includes(owner.status))) throw new Error('recipient is already owned by another watch store');
      }
      const temporary = `${file}.${process.pid}.tmp`, handle = await open(temporary,'w',0o600);
      try { await handle.writeFile(JSON.stringify({stateRoot:watch.stateRoot,id:watch.id})); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary,file);
      const dir = await open(directory,'r'); try { await dir.sync(); } finally { await dir.close(); }
    },
    async condition(watch) {
      const [binary,...args] = watch.condition.argv;
      const result = await command(binary,args,{cwd:watch.condition.cwd});
      if (result.exitCode !== 0 || result.signal) throw new Error('mechanical watch condition failed');
      const value = JSON.parse(result.stdout);
      if (typeof value?.state !== 'string' || !value.state || typeof value.actionable !== 'boolean') throw new Error('condition must return {state, actionable}');
      return {state:value.state,actionable:value.actionable};
    },
    assertExclusive:watch=>externalWatchConflict([...new Set([...externalRoots,...(watch.externalRoots ?? [])])],watch),
    observe:ready,
    async submit(watch,attempt) {
      // Repeat exact identity, composer and Working checks at the dispatch boundary.
      const current = await ready(watch,attempt);
      if (!current.ready) throw new Error('recipient became busy; submission remains pending for reconciliation');
      await transport(watch).submit(request(watch,attempt,current.observed));
    },
    async receipt(watch,attempt) {
      return transport(watch).observe(request(watch,attempt,await inspect(watch)));
    },
  };
}
