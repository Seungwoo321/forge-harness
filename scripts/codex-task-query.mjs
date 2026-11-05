#!/usr/bin/env node
import { withJsonRpcProcess } from './lib/adapters.mjs';
import { readCodexNativeGoal } from './lib/codex-native-goal.mjs';

let source = '';
for await (const chunk of process.stdin) source += chunk;
try {
  const { executable, threadId, threadIds, cwd, operation, prompt, clientId } = JSON.parse(source);
  const goalOperation = ['goal', 'goal-observe'].includes(operation);
  const nativeGoal = goalOperation ? readCodexNativeGoal(threadId) : undefined;
  const result = goalOperation && !nativeGoal && typeof cwd==='string' ? {thread:{id:threadId,cwd},turns:[],queued:[],goal:null} : await withJsonRpcProcess(executable, ['app-server', '--stdio'], async rpc => {
    if (operation === 'identify') {
      const candidates = [];
      for (const id of threadIds) {
        const { thread } = await rpc('thread/read', { threadId: id, includeTurns: false });
        if (thread.id !== id) throw new Error('thread metadata identity changed');
        if (thread.cwd === cwd && ['cli', 'exec'].includes(thread.source)) candidates.push(thread.id);
      }
      if (candidates.length !== 1) throw new Error('worker primary thread is missing or ambiguous');
      return { threadId: candidates[0] };
    }
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    if (operation === 'goal') {
      return { thread: { id: thread.id, cwd: thread.cwd }, goal: nativeGoal };
    }
    if (goalOperation && !nativeGoal) return { thread: {id:thread.id,cwd:thread.cwd}, turns:[],queued:[],goal:null };
    const turns = [];
    let cursor = null;
    do {
      const page = await rpc('thread/turns/list', { threadId, limit: 100, cursor, sortDirection: 'asc', itemsView: 'full' });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const queued = [];
    cursor = null;
    if (!goalOperation) do {
      const page = await rpc('thread/queue/list', { threadId, limit: 100, cursor });
      queued.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const goal = operation === 'goal-observe' ? nativeGoal : undefined;
    const hooks = operation === 'goal-observe' ? await rpc('hooks/list', {cwds:[cwd]}) : undefined;
    if (operation === 'queue') {
      const accepted = turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === clientId));
      if (!accepted && !queued.some(item => item.clientUserMessageId === clientId)) {
        await rpc('thread/queue/add', { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      }
    } else if (!['read', 'goal-observe'].includes(operation)) throw new Error('unsupported worker operation');
    return { thread: { id: thread.id, cwd: thread.cwd }, turns, queued, ...(operation === 'goal-observe' ? { goal, hooks } : {}) };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
