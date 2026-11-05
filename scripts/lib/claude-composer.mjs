import { taskError } from './session-task.mjs';

function composer(screen) {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const start = lines.findLastIndex(line => /^\s*❯(?:[ \u00a0]|$)/u.test(line));
  if (start < 1 || !/^\s*─{8,}\s*$/u.test(lines[start - 1]) || !/^\s*─{8,}\s*$/u.test(lines[start + 1] ?? '')
    || !lines.slice(start + 2).some(line => /shift\+tab|shortcuts|esc to interrupt/i.test(line))) throw taskError('supported Claude composer is unavailable');
  return lines[start].replace(/^\s*❯[ \u00a0]?/u, '');
}
const empty = text => !text || /^Try "[^\n]*"$/.test(text);
export function claudeComposerMatches(screen, prompt) { return composer(screen) === prompt; }

export async function submitClaudeComposer({ prompt, read, paste, enter, verify }) {
  if (/[\r\n\t]/.test(prompt) || prompt.trim() !== prompt || prompt.length > 1600) throw taskError('interactive delivery requires a short single-line packet reference');
  const before = composer(await read());
  if (before !== prompt) {
    if (!empty(before)) throw taskError('composer contains another draft');
    await verify();
    await paste(prompt);
  }
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const current = composer(await read());
    if (current === prompt) stable += 1;
    else if (empty(current)) stable = 0;
    else throw taskError('composer changed while preparing submission');
    if (stable === 2) {
      await verify();
      if (composer(await read()) !== prompt) throw taskError('composer changed before Return');
      await enter();
      return;
    }
  }
  throw taskError('pasted prompt did not settle');
}
