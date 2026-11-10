#!/usr/bin/env node
import { withJsonRpcProcess } from './lib/adapters.mjs';
import { readCodexNativeGoal } from './lib/codex-native-goal.mjs';
import { observeUnmaterializedThread } from './lib/codex-preturn.mjs';

let source = '';
for await (const chunk of process.stdin) source += chunk;
try {
  const { executable, threadId, threadIds, cwd, operation, prompt, clientId, sqliteRoot, account } = JSON.parse(source);
  const goalOperation = ['goal', 'goal-observe'].includes(operation);
  const nativeGoal = goalOperation ? readCodexNativeGoal(threadId, sqliteRoot ?? account) : undefined;
  const result = operation === 'goal' && !nativeGoal && typeof cwd==='string' ? {thread:{id:threadId,cwd},turns:[],queued:[],goal:null} : await withJsonRpcProcess(executable, ['app-server', '--stdio'], async (rpc, initialization) => {
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
    let thread;
    try { ({thread} = await rpc('thread/read', {threadId, includeTurns:false})); }
    catch (readError) {
      if (operation !== 'goal-observe' || nativeGoal) throw readError;
      return observeUnmaterializedThread({rpc,initialization,threadId,account,sqliteRoot,cwd,readError});
    }
    if (thread.id !== threadId || thread.cwd !== cwd) throw new Error('worker thread changed during observation');
    if (operation === 'goal') {
      return { thread: { id: thread.id, cwd: thread.cwd }, goal: nativeGoal };
    }
    const turns = [];
    let cursor = null;
    do {
      const page = await rpc('thread/turns/list', { threadId, limit: 100, cursor, sortDirection: 'asc', itemsView: 'full' });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const queued = [];
    cursor = null;
    do {
      const page = await rpc('thread/queue/list', { threadId, limit: 100, cursor });
      queued.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const goal = operation === 'goal-observe' ? nativeGoal : undefined;
    const hooks = operation === 'goal-observe' ? await rpc('hooks/list', {cwds:[cwd]}) : undefined;
    if (operation === 'queue') {
      const samePrompt = parts => Array.isArray(parts) && parts.length > 0 && parts.every(part => part.type === 'text' && typeof part.text === 'string') && parts.map(part => part.text).join('') === prompt;
      const accepted = turns.some(turn => turn.items.some(item => item.type === 'userMessage' && (item.clientId === clientId || samePrompt(item.content))));
      if (!accepted && !queued.some(item => item.clientUserMessageId === clientId || samePrompt(item.input))) {
        await rpc('thread/queue/add', { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      }
    } else if (!['read', 'goal-observe'].includes(operation)) throw new Error('unsupported worker operation');
    return { thread: { id: thread.id, cwd: thread.cwd }, turns, queued, ...(operation === 'goal-observe' ? { goal, hooks } : {}) };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
