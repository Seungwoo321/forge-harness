import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCodexNativeGoal } from './codex-native-goal.mjs';

// Codex rust-v0.167.0 (086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a) defers fresh
// rollouts; queue/list resolves the thread before reading the independent queue store.
export async function observeUnmaterializedThread({rpc, initialization, threadId, account, sqliteRoot, cwd, readError}) {
  if (!sqliteRoot || initialization?.codexHome !== account
    || !/^session_transport\/0\.167\.0(?: |$)/.test(initialization?.userAgent ?? '')
    || readError.rpcCode !== -32600 || readError.message !== `thread not loaded: ${threadId}`) throw readError;
  for (const [method, code, message] of [
    ['thread/turns/list', -32600, `thread not loaded: ${threadId}`],
    ['thread/queue/list', -32603, `failed to read thread: invalid thread-store request: no rollout found for thread id ${threadId}`],
  ]) {
    let failure;
    try { await rpc(method, {threadId, limit:100, cursor:null}); } catch (error) { failure = error; }
    if (failure?.rpcCode !== code || failure.message !== message) throw new Error('native unmaterialized thread classification is unverified');
  }
  let defaultLineEditing = false;
  try {
    const {config} = await rpc('config/read',{cwd,includeLayers:true});
    const defaults = value => value == null || typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(defaults);
    const tui = config?.tui;
    defaultLineEditing = config !== null && typeof config === 'object' && !Array.isArray(config)
      && (tui == null || typeof tui === 'object' && !Array.isArray(tui)
        && (tui.vim_mode_default == null || tui.vim_mode_default === false) && defaults(tui.keymap));
  } catch { /* Missing keymap evidence disables correction, not the native storage observation. */ }
  const database = new DatabaseSync(path.join(sqliteRoot, 'queue_1.sqlite'), {readOnly:true});
  try {
    const columns = database.prepare('PRAGMA table_info(queued_items)').all();
    const expected = [['id','TEXT',1,1],['thread_id','TEXT',1,0],['payload_json','TEXT',1,0],['queue_order','INTEGER',1,0],['created_at_ms','INTEGER',1,0],['updated_at_ms','INTEGER',1,0]];
    if (columns.length !== expected.length || columns.some((column,index) => JSON.stringify([column.name,column.type,column.notnull,column.pk]) !== JSON.stringify(expected[index]))) throw new Error('unsupported native queue schema');
    const count = database.prepare('SELECT COUNT(*) AS count FROM queued_items WHERE thread_id = ?').get(threadId).count;
    if (count !== 0 || readCodexNativeGoal(threadId, sqliteRoot) !== null) throw new Error('native goal or queued input is present');
    return {observation:'unmaterialized', proof:{platform:'codex/0.167.0',threadId,account,sqliteRoot,queueCount:count,defaultLineEditing},goal:null};
  } finally { database.close(); }
}
