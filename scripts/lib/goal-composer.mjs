import { taskError, taskDigest } from './session-task.mjs';

export const codexReadyFooter = /^GPT-[A-Za-z0-9.-]+(?:low|medium|high|xhigh|max)·(?:~\/|\/)[^·]+·(?:[A-Za-z0-9._/-]+·)?Ready·Context(?:100|[1-9]?\d)%left(?:·(?:weekly|daily)(?:100|[1-9]?\d)%left)?(?:·\d+(?:\.\d+)?[KMB]?window·\d+(?:\.\d+)?[KMB]?used)?(?:·Main\[default\])?(?:⚠[1-9]\d*warnings?·f2toview)?$/u;

export function nativeComposerContents(screen, provider) {
  if (typeof screen?.renderedDraft === 'string') return screen.renderedDraft;
  if (typeof screen?.draft === 'string') return screen.draft;
  if (typeof screen === 'object') screen = screen.screen;
  if (typeof screen !== 'string') throw taskError('native goal composer is unavailable');
  const lines = screen.split('\n').map(line => provider === 'codex' ? line : line.trimEnd());
  const start = lines.findLastIndex(line => provider === 'codex' ? /^ ?›(?: |$)/.test(line) : /^\s*❯(?:[ \u00a0]|$)/u.test(line));
  if (start < 0) throw taskError('native goal composer is unavailable');
  let end = lines.findIndex((line, index) => index > start && (provider === 'codex' ? /· (Ready|Working) ·/.test(line) : /^\s*─{8,}\s*$/u.test(line)));
  if (provider === 'codex') {
    const shortcuts = lines.findLastIndex((line, index) => index > start && (line.includes('? for shortcuts') || line.includes('tab to queue message')));
    const statusRow = end;
    end = shortcuts > start ? shortcuts - 1 : lines.findLastIndex(line => line.trim());
    if (shortcuts > start) {
      const hint = /^(?:← for agents · \? for shortcuts|\? for shortcuts|tab to queue message)(?: (?:Pursuing goal \(\d+[hms](?: \d+[hms])*\)(?: · ⚠ [1-9]\d* warnings? · f2 to view)?|⚠ [1-9]\d* warnings? · f2 to view))?$/u;
      if (!hint.test(lines[shortcuts].trim().replace(/[ \t]+/g, ' '))) throw taskError('native goal composer footer is ambiguous');
      if (lines.slice(shortcuts + 1).some(line => line.trim())) throw taskError('native goal composer footer is ambiguous');
    }
    while (end > start && !lines[end].trim()) end -= 1;
    // Match the complete terminal status block across soft wraps; never normalize draft text.

    const statusStart = lines.findLastIndex((line,index)=>index>start && index<=end && /^ {2}GPT-/.test(line)
      && codexReadyFooter.test(lines.slice(index,end+1).join('').replace(/\s/g,'')));
    if (statusStart > start) end = statusStart;
    else if (end <= start || !/\S.* · /.test(lines[end]) || shortcuts <= start && statusRow > start && statusRow !== end) throw taskError('native goal composer footer is ambiguous');
  }
  if (end < 0 || provider === 'claude' && !/^\s*─{8,}\s*$/u.test(lines[start - 1] ?? '')) throw taskError('native goal composer is ambiguous');
  // The UI separator has at most one space; blank draft rows retain the two-column input gutter.
  if (provider === 'codex' && end > start + 1 && /^ ?$/.test(lines[end - 1])) end -= 1;
  const contents = [lines[start].replace(provider === 'codex' ? /^\s*› ?/ : /^\s*❯[ \u00a0]?/u, ''), ...lines.slice(start + 1, end).map(line => provider === 'codex' ? line.replace(/^ {2}/, '') : line.trimStart())].join('\n');
  return provider === 'codex' ? contents : contents.replace(/\n+$/, '');
}

export function composerTextMatches(display, expected) {
  let position = 0;
  const lines = display.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!expected.startsWith(lines[index], position)) return false;
    position += lines[index].length;
    if (index + 1 < lines.length) {
      if (expected[position] === '\n') position += 1;
      else if (!lines[index] || !lines[index + 1]) return false;
      else if (expected[position] === ' ' && !lines[index + 1].startsWith(' ')) position += 1;
    }
  }
  return position === expected.length;
}

function slashLossDraft(objective) {
  const [first,...rest] = objective.split('\n'),characters = [...` ${first}`];
  return '/goal' + characters.slice(0,128).join('').replaceAll('/','') + characters.slice(128).join('') + (rest.length ? '\n'+rest.join('\n') : '');
}

function renderedMatches(screen, display, expected) {
  if (typeof screen?.renderedDraft === 'string' && !expected.includes('\n') && display.split('\n').some(line => !line)) return false;
  return composerTextMatches(display, expected);
}

export function classifyNativeGoalDraft(screen,provider,objective) {
  const expected = `/goal ${objective}`;
  const display = nativeComposerContents(screen,provider);
  const exact = text => typeof screen?.draft === 'string' ? screen.draft === text : display.startsWith('/goal ') && renderedMatches(screen,display,text);
  if (exact(expected)) return 'exact';
  if (provider === 'codex') {
    const damaged = slashLossDraft(objective);
    if (damaged !== expected && exact(damaged)) return 'slash-loss';
  }
  return 'other';
}

export function assertNativeGoalReady(screen,provider,{preTurn=false,recovery=false}={}) {
  if (preTurn) {
    const rendered = typeof screen === 'object' ? screen.screen : screen;
    const lines = typeof rendered === 'string' ? rendered.split('\n') : [];
    // The complete fresh view excludes optimistically rendered input and queue/startup
    // previews; Ready alone does not describe those fields in the pinned native versions.
    const platform = preTurn === true ? 'codex/0.167.0' : preTurn.platform;
    if (provider !== 'codex' || !/^codex\/(?:0\.167\.[01]|0\.168\.0|0\.169\.[01])$/.test(platform ?? '')
      || lines.filter(line => line.trim() === `>_ OpenAI Codex (v${platform.slice(6)})`).length !== 1
      || lines.filter(line => /^\s*›(?: |$)/.test(line)).length !== 1
      || lines.some(line => /Messages to be submitted|Queued follow-up inputs|edit last queued message|Waiting for startup|Preparing images|pending approval|approve this|request_user_input|Review plugin hooks/i.test(line))) throw taskError('fresh native receiver view is unverified');
  }
  if (recovery || preTurn) {
    const rendered = typeof screen === 'object' ? screen.screen : screen;
    const lines = typeof rendered === 'string' ? rendered.split('\n') : [];
    const start = lines.findLastIndex(line => provider === 'codex' ? /^\s*›(?: |$)/.test(line) : /^\s*❯(?:[ \u00a0]|$)/u.test(line));
    const footer = lines.slice(start + 1);
    const status = footer.find(line => /· (Ready|Working) ·/.test(line));
    if (start < 0 || (provider === 'codex' ? !status || !/· Ready ·/.test(status)
      : !footer.some(line => /shift\+tab|for shortcuts/.test(line)) || footer.some(line => /esc to interrupt/i.test(line)))) throw taskError('native goal receiver is not verifiably Ready');
  }
}

export async function submitNativeGoal({ provider, objective, read, write, newline, enter, verify, beforeWrite = () => {}, beforeEnter = () => {}, repair, resumeDraft = false, recovery = false, preTurn = false }) {
  if (!['codex','claude'].includes(provider) || typeof objective !== 'string' || !objective.trim() || /[\r\t\0\x1b]/.test(objective) || (objective.includes('\n') && typeof newline !== 'function')) throw taskError('native goal contains unsupported input');
  const requireReady = screen => assertNativeGoalReady(screen,provider,{preTurn,recovery});
  const requireEmpty = screen => {
    const current = nativeComposerContents(screen,provider);
    if (!(provider === 'codex' ? !current || ['Ask Codex to do anything','Explain this codebase','Summarize recent commits','Implement {feature}','Find and fix a bug in @filename','Write tests for @filename'].includes(current) : !current || /^Try "[^\n]*"$/.test(current))) throw taskError('native goal composer contains another draft');
    requireReady(screen);
  };
  let typeDraft = true;
  if (resumeDraft) {
    const screen = await read(); requireReady(screen); await verify();
    const state = classifyNativeGoalDraft(screen,provider,objective);
    if (state === 'exact') typeDraft = false;
    else if (state === 'slash-loss' && typeof repair === 'function') {
      await repair(async () => {
        await verify(); const current = await read(); requireReady(current);
        if (classifyNativeGoalDraft(current,provider,objective) !== 'slash-loss') throw taskError('native damaged draft changed before correction');
      },{kind:'first-burst-slash-loss',fromDigest:taskDigest(slashLossDraft(objective)),toDigest:taskDigest(`/goal ${objective}`)});
      let cleared = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await read(); requireReady(current); await verify();
        if (nativeComposerContents(current,provider) === '' || ['Ask Codex to do anything','Explain this codebase','Summarize recent commits','Implement {feature}','Find and fix a bug in @filename','Write tests for @filename'].includes(nativeComposerContents(current,provider))) { cleared = true; break; }
        if (classifyNativeGoalDraft(current,provider,objective) !== 'slash-loss') throw taskError('native damaged draft changed while clearing');
        await new Promise(resolve => setTimeout(resolve,100));
      }
      if (!cleared) throw taskError('native goal draft did not clear');
    } else throw taskError('native pending draft is not the exact original or authorized slash-loss variant');
  }
  const type = async text => {
    const characters=[...text];
    for(let offset=0;offset<characters.length;offset+=128) {
      await write(characters.slice(offset,offset+128).join(''));
      if(offset+128<characters.length)await new Promise(resolve=>setTimeout(resolve,150));
    }
  };
  if (typeDraft) {
    requireEmpty(await read()); await verify();
    if (!resumeDraft) await beforeWrite();
    requireEmpty(await read()); await verify();
    const beforeFirstInput = async () => { if (preTurn) await verify(); requireEmpty(await read()); };
    await beforeFirstInput(); await write('/',beforeFirstInput); await write('goal');
    let commandReady = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (nativeComposerContents(await read(),provider) === '/goal') { commandReady = true; break; }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    if (!commandReady) throw taskError('native goal command was not recognized');
    const parts = objective.split('\n'),first = [...parts[0]][0];
    if (provider === 'codex' && first) {
      // Flush a visible argument outside the slash-command token before '/' can be
      // consumed by the command popup while the remaining paste burst is buffered.
      await type(` ${first}`);
      let argumentReady = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (nativeComposerContents(await read(),provider) === `/goal ${first}`) { argumentReady = true; break; }
        await new Promise(resolve => setTimeout(resolve,100));
      }
      if (!argumentReady) throw taskError('native goal first argument did not settle');
      await type(parts[0].slice(first.length));
    } else await type(` ${parts[0]}`);
    for (const part of parts.slice(1)) { await newline(); if (part) await type(part); }
  }
  const expected = `/goal ${objective}`;
  // A long objective scrolls the composer so only its tail is visible; accept a display that matches a suffix
  // through the end. The exact goal text is still verified from the transcript after submission.
  const matchesClipped = display => {
    const first = display.split('\n')[0];
    if (!first) return false;
    for (let index = expected.indexOf(first); index > 0; index = expected.indexOf(first, index + 1)) {
      if (composerTextMatches(display, expected.slice(index))) return true;
    }
    return false;
  };
  const matchesDraft = screen => {
    if (preTurn || resumeDraft) requireReady(screen);
    if (typeof screen?.draft === 'string') return screen.draft === expected;
    const display = nativeComposerContents(screen, provider);
    return renderedMatches(screen,display,expected) || provider === 'claude' && !resumeDraft && matchesClipped(display);
  };
  let settled = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (matchesDraft(await read())) settled += 1;
    else settled = 0;
    if (settled === 2) {
      await verify();
      if (!matchesDraft(await read())) throw taskError('native goal composer changed before submission');
      await beforeEnter();
      await enter(async () => { if (preTurn) await verify(); if (!matchesDraft(await read())) throw taskError('native goal composer changed before submission'); });
      return;
    }
  }
  throw taskError('native goal composer did not settle');
}
