import { taskError } from './session-task.mjs';

const placeholders = new Set(['Ask Codex to do anything', 'Explain this codebase', 'Summarize recent commits',
  'Implement {feature}', 'Find and fix a bug in @filename', 'Write tests for @filename']);

function composer(screen) {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const start = lines.findLastIndex(line => /^\s*› /.test(line));
  const footer = lines.findIndex((line, index) => index > start && /· (Ready|Working) ·/.test(line));
  if (start < 0 || footer < 0 || !lines.slice(footer).some(line => line.includes('? for shortcuts') || line.includes('tab to queue message'))) throw taskError('supported Codex composer is unavailable');
  if (lines.slice(start + 1, footer).some(line => line.trim())) throw taskError('wrapped composer text is ambiguous');
  return lines[start].replace(/^\s*› /, '');
}

export function codexComposerMatches(screen, prompt) { return composer(screen) === prompt; }

export async function submitCodexComposer({ prompt, read, paste, enter, verify }) {
  if (/[\r\n\t]/.test(prompt) || prompt.trim() !== prompt || prompt.length > 1600) throw taskError('interactive delivery requires a short single-line packet reference');
  const expected = prompt;
  const before = composer(await read());
  if (before !== expected) {
    if (!placeholders.has(before)) throw taskError('composer contains another draft');
    await verify();
    await paste(prompt);
  }
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Paste bursts defer ordinary Return handling. Require separate, settled observations.
    await new Promise(resolve => setTimeout(resolve, 300));
    const current = composer(await read());
    if (current === expected) stable += 1;
    else if (placeholders.has(current)) stable = 0;
    else throw taskError('composer changed while preparing submission');
    if (stable === 2) {
      await verify();
      if (composer(await read()) !== expected) throw taskError('composer changed before Return');
      await enter();
      return;
    }
  }
  throw taskError('pasted prompt did not settle');
}
