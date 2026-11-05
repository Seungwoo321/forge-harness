import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export function readCodexNativeGoal(threadId, account = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')) {
  if (typeof threadId !== 'string' || !/^[a-f0-9-]{36}$/.test(threadId) || !path.isAbsolute(account)) throw new TypeError('exact native thread and account are required');
  const database = new DatabaseSync(path.join(account, 'goals_1.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT thread_id, goal_id, objective, status, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ?').get(threadId);
    if (!row) return null;
    if (row.thread_id !== threadId || typeof row.goal_id !== 'string' || !row.goal_id || typeof row.objective !== 'string' || !row.objective.trim()
      || !['active','paused','blocked','usage_limited','budget_limited','complete'].includes(row.status)
      || !Number.isSafeInteger(row.created_at_ms) || !Number.isSafeInteger(row.updated_at_ms)) throw new Error('unsupported native goal record');
    return { threadId: row.thread_id, id: row.goal_id, objective: row.objective, status: row.status,
      createdAt: Math.floor(row.created_at_ms / 1000), updatedAt: Math.floor(row.updated_at_ms / 1000) };
  } finally { database.close(); }
}
