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
