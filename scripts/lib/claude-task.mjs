import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { taskDigest, taskError } from './session-task.mjs';

const textOf = message => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('') : '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createClaudeTaskTransport({ command, env, submitInput }) {
  async function binding(observed) {
    if (!Number.isSafeInteger(observed.pid) || !path.isAbsolute(env?.CLAUDE_CONFIG_DIR ?? '')) throw taskError('Claude process or account is unavailable');
    const result = await command('ps', ['-ww','-p',String(observed.pid),'-o','args='], {cwd:observed.cwd});
    if (result.exitCode !== 0 || result.signal) throw taskError('Claude process identity is unavailable');
    const matches = [...result.stdout.matchAll(/(?:^|\s)--session-id(?:=|\s+)([0-9a-f-]{36})(?=\s|$)/ig)];
    if (matches.length !== 1 || !uuid.test(matches[0][1])) throw taskError('Claude session identity is missing or ambiguous');
    return matches[0][1].toLowerCase();
  }
  async function transcript(sessionId) {
    const root = path.join(env.CLAUDE_CONFIG_DIR,'projects');
    let directories;
    try { directories = await readdir(root,{withFileTypes:true}); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const matches = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root,entry.name,`${sessionId}.jsonl`);
      try { const info=await stat(file); if (info.isFile()) matches.push({file,size:info.size}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (matches.length > 1) throw taskError('Claude transcript is ambiguous');
    if (!matches.length) return null;
    if (matches[0].size > 64 * 1024 * 1024) throw taskError('Claude transcript exceeds observation limit');
    const data = await readFile(matches[0].file,'utf8');
    const lines = data.split('\n'); if (lines.at(-1)) lines.pop();
    try { return lines.filter(Boolean).map(line=>JSON.parse(line)); } catch { throw taskError('Claude transcript is malformed'); }
  }
  return {
    async identity(observed) { return {threadId:await binding(observed)}; },
    async observeGoal(request) {
      const threadId = await binding(request.observed);
      const rows = await transcript(threadId);
      if (await binding(request.observed) !== threadId) throw taskError('Claude process changed during observation');
      if (!rows) return {state:'absent'};
      const relevant = rows.filter(row => row.sessionId?.toLowerCase() === threadId && row.isSidechain !== true && row.cwd === request.observed.cwd);
      const statuses = relevant.filter(row => row.type === 'attachment' && row.attachment?.type === 'goal_status');
      const status = statuses.at(-1)?.attachment;
      if (!status) return {state:'absent'};
      if (status.condition !== request.prompt || status.met !== false) throw taskError('native goal differs from the intended active goal');
      const command = `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${request.prompt}</command-args>`;
      const matches = relevant.filter(row => row.type === 'user' && row.isMeta !== true && textOf(row.message) === command && typeof row.uuid === 'string');
      if (matches.length !== 1) throw taskError('native goal command is missing or ambiguous');
      if (relevant.slice(relevant.indexOf(statuses.at(-1)) + 1).some(row => row.type === 'user'
        && /<local-command-stdout>\s*(?:Goal cleared:|No goal set)/.test(textOf(row.message)))) throw taskError('native goal was cleared');
      const descendants = new Set([matches[0].uuid]);
      const reads = new Map(), verified = new Set();
      let activity;
      for (const row of relevant.slice(relevant.indexOf(matches[0]) + 1)) {
        if (!descendants.has(row.parentUuid) || typeof row.uuid !== 'string') continue;
        descendants.add(row.uuid);
        const content = Array.isArray(row.message?.content) ? row.message.content : [];
        if (row.type === 'assistant' && content.some(part => ['text','tool_use'].includes(part?.type))) activity ??= row;
        for (const part of content) {
          if (row.type === 'assistant' && part.type === 'tool_use' && part.name === 'Read' && typeof part.id === 'string') reads.set(part.id, part.input?.file_path);
          if (row.type === 'user' && part.type === 'tool_result' && !part.is_error && typeof part.content === 'string') {
            for (const packet of request.packets) {
              const numbered = packet.content.split('\n').map((line,index)=>`${index+1}\t${line}`).join('\n');
              if (reads.get(part.tool_use_id) === packet.path && part.content === numbered) verified.add(packet.path);
            }
          }
        }
      }
      if (activity && request.packets.every(packet => verified.has(packet.path))) {
        return {state:'started',threadId,goal:{threadId,status:'active',objective:status.condition},requestId:matches[0].uuid,turnId:matches[0].uuid,activityId:activity.uuid,packets:request.packets.map(({path,digest})=>({path,digest}))};
      }
      return {state:'accepted',threadId,goal:{threadId,status:'active',objective:status.condition}};
    },
    async observe(request) {
      const threadId = await binding(request.observed);
      const rows = await transcript(threadId);
      if (await binding(request.observed) !== threadId) throw taskError('Claude process changed during observation');
      if (!rows) return {state:request.input.effect === 'session.deliver' ? 'ready' : 'startup',fence:threadId,notApplied:true};
      const matches = rows.filter(row => row.type === 'user' && row.isSidechain !== true && row.sessionId?.toLowerCase() === threadId
        && row.cwd === request.observed.cwd && textOf(row.message) === request.prompt && typeof row.uuid === 'string');
      if (matches.length > 1) throw taskError('Claude request appears more than once');
      if (!matches.length) return request.input.effect === 'session.deliver' ? {state:'ready',fence:threadId,notApplied:true} : {state:'startup'};
      const user=matches[0], index=rows.indexOf(user), descendants=new Set([user.uuid]);
      let activity;
      const reads = new Map(), verified = new Set();
      for (const row of rows.slice(index+1)) {
        if (row.sessionId?.toLowerCase() !== threadId || row.isSidechain === true || !descendants.has(row.parentUuid) || typeof row.uuid !== 'string') continue;
        if (row.type === 'user' && typeof row.message?.content === 'string') break;
        descendants.add(row.uuid);
        const content = Array.isArray(row.message?.content) ? row.message.content : [];
        if (row.type === 'assistant' && content.some(part=>['text','tool_use'].includes(part?.type))) activity ??= row;
        for (const part of content) {
          if (row.type === 'assistant' && part.type === 'tool_use' && part.name === 'Read' && typeof part.id === 'string') reads.set(part.id,part.input?.file_path);
          if (row.type === 'user' && part.type === 'tool_result' && !part.is_error && typeof part.content === 'string') {
            for (const packet of request.packets) {
              const numbered = packet.content.split('\n').map((line,index)=>`${index+1}\t${line}`).join('\n');
              if (reads.get(part.tool_use_id) === packet.path && part.content === numbered) verified.add(packet.path);
            }
          }
        }
      }
      if (!activity) return {state:'accepted'};
      const packets = request.packets.filter(packet => (request.prompt.includes(packet.path) && request.prompt.includes(packet.digest) && request.prompt.includes(packet.content)) || verified.has(packet.path));
      if (packets.length !== request.packets.length) return {state:'accepted'};
      return {state:'started',promptDigest:taskDigest(request.prompt),threadId,requestId:user.uuid,turnId:user.uuid,activityId:activity.uuid,packets:packets.map(({path,digest})=>({path,digest}))};
    },
    async submit(request) {
      if (request.input.effect !== 'session.deliver' || !submitInput || await binding(request.observed) !== request.fence) throw taskError('Claude conditional submission is unavailable');
      return submitInput(request, async () => {
        if (await binding(request.observed) !== request.fence || (await this.observe(request)).state !== 'ready') throw taskError('Claude readiness changed');
      });
    },
  };
}
