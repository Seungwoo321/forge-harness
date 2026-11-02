import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskDigest, taskError } from './session-task.mjs';

const queryScript = fileURLToPath(new URL('../codex-task-query.mjs', import.meta.url));
const textOf = item => (item.content ?? []).map(part => part.type === 'text' ? part.text : '').join('');

export function createCodexTaskTransport({ command, executable = 'codex' }) {
  async function binding(observed) {
    if (!Number.isSafeInteger(observed.pid)) throw taskError('worker PID is unavailable');
    const result = await command('lsof', ['-a', '-p', String(observed.pid), '-Fn'], { cwd: observed.cwd });
    if (result.exitCode !== 0 || result.signal) throw taskError('worker thread ownership is unavailable');
    const ids = [...new Set(result.stdout.split('\n').map(line => /\/thread-writer-locks\/([a-f0-9-]{36})\.lock$/.exec(line)?.[1]).filter(Boolean))];
    if (ids.length !== 1) throw taskError('worker thread ownership is missing or ambiguous');
    return ids[0];
  }
  async function query(request, operation = 'read') {
    const threadId = await binding(request.observed);
    const result = await command(process.execPath, [queryScript], { cwd: request.observed.cwd,
      input: JSON.stringify({ executable, threadId, operation, prompt: request.prompt, clientId: request.input.key }) });
    if (result.exitCode !== 0 || result.signal) throw taskError('native worker history is unavailable');
    const data = JSON.parse(result.stdout);
    if (data.thread?.id !== threadId || data.thread.cwd !== request.observed.cwd || await binding(request.observed) !== threadId) throw taskError('worker thread changed during observation');
    return { ...data, threadId };
  }
  return {
    async identity(observed) { return { threadId: await binding(observed) }; },
    async observe(request) {
      const data = await query(request);
      const matches = data.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage' && textOf(item) === request.prompt).map(item => ({ turn, item })));
      if (matches.length > 1) throw taskError('request appears more than once');
      if (matches.length === 1) {
        const { turn, item } = matches[0];
        const activity = turn.items.slice(turn.items.indexOf(item) + 1).find(value => ['agentMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(value.type));
        if (!activity || !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) return { state: 'accepted' };
        const packets = request.packets.filter(packet => request.prompt.includes(packet.digest) && request.prompt.includes(packet.content)
          || turn.items.some(value => value.type === 'commandExecution' && value.status === 'completed' && value.exitCode === 0
            && value.commandActions?.some(action => action.type === 'read' && (action.path === packet.path || path.resolve(value.cwd, action.path ?? '') === packet.path))
            && taskDigest(value.aggregatedOutput ?? '') === packet.digest));
        return { state: 'started', promptDigest: taskDigest(request.prompt), threadId: data.threadId, requestId: item.id,
          turnId: turn.id, turnStatus: turn.status, activityId: activity.id, packets: packets.map(({ path, digest }) => ({ path, digest })) };
      }
      if (data.queued.some(item => item.clientUserMessageId === request.input.key || textOf({ content: item.input }) === request.prompt)) return { state: 'queued' };
      // Initial argv input belongs to the TUI. Repeating it while startup is pending is unsafe.
      return request.input.effect === 'session.deliver' ? { state: 'ready', fence: data.threadId } : { state: 'startup' };
    },
    async submit(request) {
      if (request.input.effect !== 'session.deliver' || await binding(request.observed) !== request.fence) throw taskError('worker readiness fence changed');
      await query(request, 'queue');
    },
  };
}
