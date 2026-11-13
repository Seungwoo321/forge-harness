import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { taskDigest, taskError } from './session-task.mjs';

const queryScript = fileURLToPath(new URL('../codex-task-query.mjs', import.meta.url));
const textOf = item => Array.isArray(item.content) && item.content.length > 0 && item.content.every(part => part.type === 'text' && typeof part.text === 'string')
  ? item.content.map(part => part.text).join('') : null;
const readPacket = (packet, value, verification = [], exactOutput = false) => {
  if (value.type !== 'commandExecution' || value.status !== 'completed' || value.exitCode !== 0) return false;
  const output = value.aggregatedOutput ?? '';
  const read = value.commandActions?.some(action => action.type === 'read'
    && (action.path === packet.path || path.resolve(value.cwd, action.path ?? '') === packet.path));
  if (read && taskDigest(output) === packet.digest) return true;
  if (exactOutput) return false;
  const outputs = read ? [value, ...verification] : [value];
  return Boolean(packet.content && output.includes(packet.content) && outputs.some(item => item.type === 'commandExecution'
    && item.status === 'completed' && item.exitCode === 0 && item.aggregatedOutput?.split('\n').some(line => {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    return match && `sha256:${match[1]}` === packet.digest && path.resolve(item.cwd, match[2]) === packet.path;
  })));
};

export function createCodexTaskTransport({ command, executable = 'codex', submitInput, env }) {
  const account = path.resolve(env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  async function binding(observed) {
    if (!Number.isSafeInteger(observed.pid)) throw taskError('worker PID is unavailable');
    const result = await command('lsof', ['-a', '-p', String(observed.pid), '-Fn'], { cwd: observed.cwd });
    if (result.exitCode !== 0 || result.signal) throw taskError('worker thread ownership is unavailable');
    const lockRoot = `n${path.join(account, 'thread-writer-locks')}/`;
    const ids = [...new Set(result.stdout.split('\n').filter(line => line.startsWith(lockRoot))
      .map(line => /^([a-f0-9-]{36})\.lock$/.exec(line.slice(lockRoot.length))?.[1]).filter(Boolean))];
    if (!ids.length) throw taskError('worker thread ownership is missing');
    if (ids.length > 1) {
      const identified = await command(process.execPath, [queryScript], { cwd: observed.cwd, env,
        input: JSON.stringify({ executable, operation: 'identify', threadIds: ids, cwd: observed.cwd }) });
      if (identified.exitCode !== 0 || identified.signal) throw taskError('worker primary thread is missing or ambiguous');
      const { threadId } = JSON.parse(identified.stdout);
      if (!ids.includes(threadId)) throw taskError('primary thread is not owned by the worker');
      return {threadId,sqliteRoot:storageRoot(result.stdout)};
    }
    return {threadId:ids[0],sqliteRoot:storageRoot(result.stdout)};
  }
  function storageRoot(stdout) {
    const roots = [...new Set(stdout.split('\n').filter(line => line.startsWith('n/') && path.basename(line.slice(1)) === 'queue_1.sqlite').map(line => path.dirname(line.slice(1))))];
    return roots.length === 1 ? roots[0] : undefined;
  }
  async function query(request, operation = 'read') {
    const {threadId,sqliteRoot} = await binding(request.observed);
    if (operation === 'queue' && threadId !== request.fence) throw taskError('worker readiness fence changed');
    const result = await command(process.execPath, [queryScript], { cwd: request.observed.cwd, env,
      input: JSON.stringify({ executable, threadId, sqliteRoot, account, cwd:request.observed.cwd, operation, prompt: request.prompt, clientId: request.input.key }) });
    if (result.exitCode !== 0 || result.signal) throw taskError('native worker history is unavailable');
    const data = JSON.parse(result.stdout);
    const current = await binding(request.observed);
    const unmaterialized = data.observation === 'unmaterialized' && /^codex\/(?:0\.167\.[01]|0\.168\.0)$/.test(data.proof?.platform ?? '')
      && data.proof.threadId === threadId && data.proof.account === account && data.proof.sqliteRoot === sqliteRoot
      && sqliteRoot && current.sqliteRoot === sqliteRoot && data.proof.queueCount === 0 && data.goal === null;
    if (current.threadId !== threadId || (data.observation === 'unmaterialized' ? !unmaterialized
      : data.thread?.id !== threadId || data.thread.cwd !== request.observed.cwd)) throw taskError('worker thread changed during observation');
    return { ...data, threadId };
  }
  return {
    async identity(observed) { return { threadId: (await binding(observed)).threadId }; },
    async goal(observed) {
      const data = await query({ observed, input: {} }, 'goal');
      return data.goal;
    },
    async observeGoal(request) {
      const data = await query(request, 'goal-observe');
      if (data.observation === 'unmaterialized') return {state:'unmaterialized',threadId:data.threadId,proof:data.proof};
      if (!data.goal) {
        const absent = Array.isArray(data.turns) && data.turns.length === 0 && Array.isArray(data.queued) && data.queued.length === 0;
        return {state:absent ? 'absent' : 'unknown',threadId:data.threadId,fence:data.threadId,notApplied:absent};
      }
      if (data.goal.threadId !== data.threadId || data.goal.objective !== request.prompt || !['active','complete'].includes(data.goal.status)) {
        throw taskError('native goal differs from the intended runnable or completed goal');
      }
      // The goal timestamp has second precision; only later events prove ordering.
      const cutoff = Number.isSafeInteger(data.goal.createdAt) ? (data.goal.createdAt + 1) * 1000 : Infinity;
      const hookEntry = data.hooks?.data?.find(entry => entry.cwd === request.observed.cwd);
      const guard = hookEntry?.errors?.length === 0 && hookEntry.hooks?.find(hook => hook.pluginId === 'forge-harness@forge-harness'
        && hook.source === 'plugin' && hook.eventName === 'stop' && hook.enabled === true && hook.async === false
        && ['trusted','managed'].includes(hook.trustStatus) && hook.handlerType === 'command'
        && /[\/\\]continuity-stop-hook\.mjs["']?$/.test(hook.command));
      const enforcement = guard ? {status:'verified',provider:'codex',scope:'account-cwd',cwd:request.observed.cwd,key:guard.key,hash:guard.currentHash,trust:guard.trustStatus}
        : {status:'unverified',provider:'codex',scope:'account-cwd'};
      const eligible = data.turns.map(turn => ({ ...turn, items: turn.items.filter(item =>
        Number.isSafeInteger(turn.startedAt) && turn.startedAt * 1000 >= cutoff
        || Number.isSafeInteger(item.startedAtMs) && item.startedAtMs >= cutoff) }));
      const packets = request.packets.filter(packet => eligible.some(turn => turn.items.some((item, index) => readPacket(packet, item, turn.items.slice(index + 1)))));
      for (const turn of eligible) {
        const activity = turn.items.find(item => ['agentMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(item.type));
        if (activity && packets.length === request.packets.length && ['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) {
          return { state: 'started', threadId: data.threadId, goal: data.goal, enforcement, turnId: turn.id, activityId: activity.id, packets: packets.map(({path,digest}) => ({path,digest})) };
        }
      }
      return { state: 'accepted', threadId: data.threadId, goal: data.goal };
    },
    async observe(request) {
      const data = await query(request);
      const active = data.turns.some(turn => turn.status === 'inProgress');
      const matches = data.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage' && textOf(item) === request.prompt).map(item => ({ turn, item })));
      if (matches.length > 1) throw taskError('request appears more than once');
      if (matches.length === 1) {
        const { turn, item } = matches[0];
        const following = turn.items.slice(turn.items.indexOf(item) + 1);
        const activity = following.find(value => ['agentMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(value.type));
        // A native user command can receive a delivery even when the model request failed.
        // Keep that read provenance separate from the original accepted request.
        if (request.input.effect === 'session.deliver' && ['completed', 'interrupted', 'failed'].includes(turn.status) && !following.length && request.packets.length) {
          const reads = new Map();
          for (const later of data.turns.slice(data.turns.indexOf(turn) + 1)) {
            if (!later.id || later.status !== 'completed' || !later.items.length || !later.items.every(value => value.type === 'commandExecution' && value.id)) break;
            for (const value of later.items) for (const packet of request.packets) {
              if (readPacket(packet, value, [], true)) reads.set(packet.path, { path: packet.path, digest: packet.digest, activityTurnId: later.id, activityId: value.id });
            }
            if (request.packets.every(packet => reads.get(packet.path)?.digest === packet.digest)) {
              const read = [...reads.values()].at(-1);
              return { state: 'started', active, promptDigest: taskDigest(request.prompt), threadId: data.threadId, requestId: item.id,
                turnId: turn.id, requestTurnId: turn.id, turnStatus: turn.status, activityTurnId: read.activityTurnId, activityId: read.activityId,
                receiptSource: 'native-user-command-read', packets: [...reads.values()] };
            }
          }
        }
        if (!activity || !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) return { state: 'accepted', active };
        const packets = request.packets.filter(packet => request.prompt.includes(packet.digest) && request.prompt.includes(packet.content)
          || following.some(value => readPacket(packet, value)));
        return { state: 'started', active, promptDigest: taskDigest(request.prompt), threadId: data.threadId, requestId: item.id,
          turnId: turn.id, turnStatus: turn.status, activityId: activity.id, packets: packets.map(({ path, digest }) => ({ path, digest })) };
      }
      if (data.queued.some(item => item.clientUserMessageId === request.input.key || textOf({ content: item.input }) === request.prompt)) return { state: 'queued', active };
      // Initial argv input belongs to the TUI. Repeating it while startup is pending is unsafe.
      return request.input.effect === 'session.deliver' ? { state: 'ready', fence: data.threadId, notApplied: true,
        active } : { state: 'startup' };
    },
    async submit(request) {
      if (request.input.effect !== 'session.deliver' || (await binding(request.observed)).threadId !== request.fence) throw taskError('worker readiness fence changed');
      if (submitInput) return submitInput(request, async () => {
        if ((await binding(request.observed)).threadId !== request.fence) throw taskError('worker readiness fence changed');
        const current = await this.observe(request);
        if (current.state !== 'ready') throw taskError('request is already queued or accepted');
        if (current.fence !== request.fence) throw taskError('worker readiness fence changed');
      });
      await query(request, 'queue');
    },
  };
}
