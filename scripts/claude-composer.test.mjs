import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claudeComposerFaint,claudeComposerMatches,submitClaudeComposer} from './lib/claude-composer.mjs';

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

// Shape of the cmux render grid observed for a Claude placeholder row.
const grid = (text, faint) => ({ styles: [{ id: 0, faint: false }, { id: 1, faint: true }, { id: 2, faint: false }],
  row_spans: [{ row: 0, column: 0, style_id: 2, text: '─'.repeat(40) }, { row: 1, column: 0, style_id: 0, text: '❯\u00a0' },
    ...(text ? [{ row: 1, column: 2, style_id: faint ? 1 : 0, text }] : []), { row: 2, column: 0, style_id: 2, text: '─'.repeat(40) }] });
test('a faint prompt suggestion is replaced like a placeholder while a typed draft is preserved', async () => {
  assert.equal(claudeComposerFaint(grid('review-2 리뷰어를 0.1.81로 시작하세요', true)), true);
  assert.equal(claudeComposerFaint(grid('review-2 리뷰어를 0.1.81로 시작하세요', false)), false);
  assert.equal(claudeComposerFaint(grid('', true)), false);
  assert.equal(claudeComposerFaint({ styles: [], row_spans: [] }), false);
  const mixed = grid('typed', false); mixed.row_spans.splice(2, 0, { row: 1, column: 7, style_id: 1, text: ' suggestion' });
  assert.equal(claudeComposerFaint(mixed), false);
  let value = 'review-2 리뷰어를 0.1.81로 시작하세요', suggestion = true, pasted = 0, entered = 0;
  const run = () => submitClaudeComposer({ prompt: 'Read result', read: async () => screen(value),
    paste: async text => { value = text; suggestion = false; pasted++; }, enter: async () => entered++, verify: async () => {},
    placeholder: async () => suggestion });
  await run();
  assert.equal(pasted, 1); assert.equal(entered, 1);
  value = 'typed by the user'; suggestion = false;
  await assert.rejects(run(), /another draft/); assert.equal(pasted, 1); assert.equal(entered, 1);
});

test('the composer is recognized when the mode hint omits shift+tab because background work is listed', () => {
  const box = footer => `history\n────────────────────\n❯ Read result\n────────────────────\n  project · branch · Sonnet\n  ${footer}\n`;
  assert.equal(claudeComposerMatches(box('⏵⏵ bypass permissions on · 1 shell · ← 1 agent · ↓ to manage'), 'Read result'), true);
  assert.equal(claudeComposerMatches(box('⏸ plan mode on · 1 shell'), 'Read result'), true);
  assert.throws(() => claudeComposerMatches(box('unrelated status'), 'Read result'), /composer/);
});
