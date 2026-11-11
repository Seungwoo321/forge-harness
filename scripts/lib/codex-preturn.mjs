import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCodexNativeGoal } from './codex-native-goal.mjs';

// The pinned 0.167.0/0.167.1 contracts defer fresh rollouts; see ADR 0038.
// queue/list resolves the thread before reading the independent queue store.
export async function observeUnmaterializedThread({rpc, initialization, threadId, account, sqliteRoot, cwd, readError}) {
  const version = /^session_transport\/(0\.167\.[01])(?: |$)/.exec(initialization?.userAgent ?? '')?.[1];
  if (!sqliteRoot || initialization?.codexHome !== account
    || !version
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
    return {observation:'unmaterialized', proof:{platform:`codex/${version}`,threadId,account,sqliteRoot,queueCount:count,defaultLineEditing},goal:null};
  } finally { database.close(); }
}
