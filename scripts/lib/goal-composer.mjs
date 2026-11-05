import { taskError } from './session-task.mjs';

function contents(screen, provider) {
  if (typeof screen?.draft === 'string') return screen.draft;
  if (typeof screen === 'object') screen = screen.screen;
  if (typeof screen !== 'string') throw taskError('native goal composer is unavailable');
  const lines = screen.split('\n').map(line => line.trimEnd());
  const start = lines.findLastIndex(line => provider === 'codex' ? /^\s*›(?: |$)/.test(line) : /^\s*❯(?:[ \u00a0]|$)/u.test(line));
  if (start < 0) throw taskError('native goal composer is unavailable');
  let end = lines.findIndex((line, index) => index > start && (provider === 'codex' ? /· (Ready|Working) ·/.test(line) : /^\s*─{8,}\s*$/u.test(line)));
  if (provider === 'codex' && end < 0) {
    const shortcuts = lines.findIndex((line, index) => index > start && line.includes('? for shortcuts'));
    if (shortcuts > start + 1) {
      end = shortcuts - 1;
      while (end > start && !lines[end].trim()) end -= 1;
    }
    if (end < 0) end = lines.findIndex((line, index) => index > start && /\S.* · /.test(line));
  }
  if (end < 0 || provider === 'claude' && !/^\s*─{8,}\s*$/u.test(lines[start - 1] ?? '')) throw taskError('native goal composer is ambiguous');
  return [lines[start].replace(provider === 'codex' ? /^\s*› ?/ : /^\s*❯[ \u00a0]?/u, ''), ...lines.slice(start + 1, end).map(line => line.trimStart())].join('\n').trim();
}

function matches(display, expected) {
  let position = 0;
  const lines = display.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!expected.startsWith(lines[index], position)) return false;
    position += lines[index].length;
    if (index + 1 < lines.length) {
      if (expected[position] === '\n') position += 1;
      else if (expected[position] === ' ') position += 1;
    }
  }
  return position === expected.length;
}

export async function submitNativeGoal({ provider, objective, read, write, newline, enter, verify, beforeWrite = () => {} }) {
  if (!['codex','claude'].includes(provider) || typeof objective !== 'string' || !objective.trim() || /[\r\t\0\x1b]/.test(objective) || (objective.includes('\n') && typeof newline !== 'function')) throw taskError('native goal contains unsupported input');
  const current = contents(await read(), provider);
  if (!(provider === 'codex' ? !current || ['Ask Codex to do anything','Explain this codebase','Summarize recent commits','Implement {feature}','Find and fix a bug in @filename','Write tests for @filename'].includes(current) : !current || /^Try "[^\n]*"$/.test(current))) throw taskError('native goal composer contains another draft');
  await verify();
  beforeWrite();
  await write('/');
  await write('goal');
  let commandReady = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (contents(await read(), provider) === '/goal') { commandReady = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!commandReady) throw taskError('native goal command was not recognized');
  const parts = objective.split('\n');
  const type = async text => {
    const characters=[...text];
    for(let offset=0;offset<characters.length;offset+=128) {
      await write(characters.slice(offset,offset+128).join(''));
      if(offset+128<characters.length)await new Promise(resolve=>setTimeout(resolve,150));
    }
  };
  await type(` ${parts[0]}`);
  for (const part of parts.slice(1)) {
    await newline();
    if (part) await type(part);
  }
  const expected = `/goal ${objective}`;
  const matchesDraft = screen => typeof screen?.draft === 'string'
    ? screen.draft === expected : matches(contents(screen, provider), expected);
  let settled = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (matchesDraft(await read())) settled += 1;
    else settled = 0;
    if (settled === 2) {
      await verify();
      if (!matchesDraft(await read())) throw taskError('native goal composer changed before submission');
      await enter();
      return;
    }
  }
  throw taskError('native goal composer did not settle');
}
