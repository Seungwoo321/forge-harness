import { taskError } from './session-task.mjs';
import { nativeComposerContents, composerTextMatches } from './goal-composer.mjs';

const placeholders = new Set(['Ask Codex to do anything', 'Explain this codebase', 'Summarize recent commits',
  'Implement {feature}', 'Find and fix a bug in @filename', 'Write tests for @filename']);

function composer(screen) {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const start = lines.findLastIndex(line => /^ ?› /.test(line));
  if (start < 0 || lines.slice(start+1).some(line=>/· Working ·/.test(line))) throw taskError('supported Codex composer is unavailable');
  const end = lines.findLastIndex(line=>line.trim().length > 0);
  // Codex 0.167.0 can omit the hint row when its configured status line fills the viewport.
  const footer = /^ {2}GPT-[A-Za-z0-9.-]+ (?:low|medium|high|xhigh|max) · (?:~\/|\/)[^·\n]+ · (?:[A-Za-z0-9._/-]+ · )?Ready ·…(?:  ⚠ [1-9]\d* warnings? · f2 to view)?$/u;
  if (end > start && footer.test(lines[end])) {
    return [lines[start].replace(/^ ?› /,''),...lines.slice(start+1,end).map(line=>line.replace(/^ {2}/,''))].join('\n').replace(/\n+$/,'');
  }
  if (end <= start || !(lines[end].includes('? for shortcuts') || lines[end].includes('tab to queue message'))) throw taskError('supported Codex composer is unavailable');
  return nativeComposerContents(screen, 'codex');
}

export function codexComposerWorking(screen) {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const start = lines.findLastIndex(line => /^ ?› /.test(line));
  const footer = lines.slice(start + 1).findLast(line => /^ {2}GPT-[A-Za-z0-9.-]+ (?:low|medium|high|xhigh|max) · /.test(line));
  return start >= 0 && /· Working ·/.test(footer ?? '');
}

export function codexComposerMatches(screen, prompt) { return composerTextMatches(composer(screen), prompt); }

export async function submitCodexComposer({ prompt, read, paste, enter, verify, beforePaste = () => {}, beforeEnter = () => {} }) {
  if (/[\r\n\t]/.test(prompt) || prompt.trim() !== prompt || prompt.length > 1600) throw taskError('interactive delivery requires a short single-line packet reference');
  const expected = prompt;
  const before = composer(await read());
  if (!composerTextMatches(before, expected)) {
    if (!placeholders.has(before)) throw taskError('composer contains another draft');
    await verify();
    if (composer(await read()) !== before) throw taskError('composer changed before paste');
    await beforePaste();
    await verify();
    if (composer(await read()) !== before) throw taskError('composer changed at paste boundary');
    await paste(prompt);
  }
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Paste bursts defer ordinary Return handling. Require separate, settled observations.
    await new Promise(resolve => setTimeout(resolve, 300));
    const current = composer(await read());
    if (composerTextMatches(current, expected)) stable += 1;
    else if (placeholders.has(current)) stable = 0;
    else throw taskError('composer changed while preparing submission');
    if (stable === 2) {
      await verify();
      if (!codexComposerMatches(await read(), expected)) throw taskError('composer changed before Return');
      await beforeEnter();
      await verify();
      if (!codexComposerMatches(await read(), expected)) throw taskError('composer changed at Return boundary');
      await enter();
      return;
    }
  }
  throw taskError('pasted prompt did not settle');
}
