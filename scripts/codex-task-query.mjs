#!/usr/bin/env node
import { withJsonRpcProcess } from './lib/adapters.mjs';

let source = '';
for await (const chunk of process.stdin) source += chunk;
try {
  const { executable, threadId, threadIds, cwd, operation, prompt, clientId } = JSON.parse(source);
  const result = await withJsonRpcProcess(executable, ['app-server', '--stdio'], async rpc => {
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
      const { goal } = await rpc('thread/goal/get', { threadId });
      return { thread: { id: thread.id, cwd: thread.cwd }, goal };
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
    const goal = operation === 'goal-observe' ? (await rpc('thread/goal/get', { threadId })).goal : undefined;
    if (operation === 'queue') {
      const accepted = turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === clientId));
      if (!accepted && !queued.some(item => item.clientUserMessageId === clientId)) {
        await rpc('thread/queue/add', { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      }
    } else if (!['read', 'goal-observe'].includes(operation)) throw new Error('unsupported worker operation');
    return { thread: { id: thread.id, cwd: thread.cwd }, turns, queued, ...(operation === 'goal-observe' ? { goal } : {}) };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
