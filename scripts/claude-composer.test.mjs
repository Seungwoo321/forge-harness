import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claudeComposerMatches,submitClaudeComposer} from './lib/claude-composer.mjs';

const screen = value => `history\n────────────────────\n❯ ${value}\n────────────────────\n  shift+tab to cycle\n`;
test('Claude composer preserves other drafts and submits only a settled exact input',async () => {
  let value='', pasted=0, entered=0, verified=0;
  const run=()=>submitClaudeComposer({prompt:'Read result',read:async()=>screen(value),paste:async text=>{value=text;pasted++;},enter:async()=>entered++,verify:async()=>verified++});
  await run();
  assert.equal(pasted,1);assert.equal(entered,1);assert.equal(verified,2);
  assert.equal(claudeComposerMatches(screen(value),'Read result'),true);
  value='other draft';await assert.rejects(run(),/another draft/);assert.equal(entered,1);
  assert.throws(()=>claudeComposerMatches('❯ Read result','Read result'),/composer/);
});

// A narrow recipient soft-wraps the packet reference over several input rows.
const wrapped = (value, width = 40) => {
  const rows = [];
  for (let rest = value, first = true; rest || first; first = false) { const take = width - 2; rows.push(`${first ? '❯ ' : '  '}${rest.slice(0, take)}`); rest = rest.slice(take); }
  return `history\n${'─'.repeat(width)}\n${rows.join('\n')}\n${'─'.repeat(width)}\n  shift+tab to cycle\n`;
};
test('Claude composer submits a packet reference wider than the viewport only after the full wrapped draft settles', async () => {
  const prompt = `Read /state/units/review/result.md (sha256:${'a'.repeat(64)}); follow its referenced handoffs.`;
  let value = '', entered = 0;
  await submitClaudeComposer({prompt, read: async () => wrapped(value), paste: async text => { value = text; }, enter: async () => entered++, verify: async () => {}});
  assert.equal(entered, 1);
  assert.equal(claudeComposerMatches(wrapped(prompt), prompt), true);
  assert.equal(claudeComposerMatches(wrapped(prompt.slice(0, -1)), prompt), false);
  assert.equal(claudeComposerMatches(wrapped(`${prompt} extra`), prompt), false);
  value = `${prompt.slice(0, 50)}other draft`;
  await assert.rejects(submitClaudeComposer({prompt, read: async () => wrapped(value), paste: async () => assert.fail('pasted over a draft'), enter: async () => entered++, verify: async () => {}}), /another draft/);
  assert.equal(entered, 1);
});
