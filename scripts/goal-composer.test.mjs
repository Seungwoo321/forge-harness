import test from 'node:test';
import assert from 'node:assert/strict';
import { submitNativeGoal } from './lib/goal-composer.mjs';

test('native goal is typed as a command and separately submitted after the composer settles', async () => {
  for (const provider of ['codex','claude']) {
    let draft = '', entered = 0;
    const writes = [];
    const screen = () => provider === 'codex'
      ? `› ${draft || 'Ask Codex to do anything'}\n\n model · Ready · context\n ? for shortcuts`
      : `────────────\n❯ ${draft || 'Try "example"'}\n────────────\n shift+tab`;
    await submitNativeGoal({provider,objective:'finish the work',read:async()=>screen(),write:async text=>{writes.push(text);draft+=text;},enter:async()=>{entered+=1;},verify:async()=>{}});
    assert.deepEqual(writes,['/','goal',' finish the work']);
    assert.equal(entered,1);
  }
});

test('native goal does not overwrite an existing draft', async () => {
  let writes=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',read:async()=> '› unrelated\n model · Ready · context\n ? for shortcuts',write:async()=>{writes+=1;},enter:async()=>{},verify:async()=>{}}),/another draft/);
  assert.equal(writes,0);
});

test('multiline objectives use a newline key before separate submission', async () => {
  let draft='', entered=0, newlines=0;
  const read=async()=>`› ${(draft || 'Ask Codex to do anything').replaceAll('\n','\n  ')}\n\n model · Ready · context\n ? for shortcuts`;
  await submitNativeGoal({provider:'codex',objective:'first line\nsecond line',read,
    write:async text=>{draft+=text;},newline:async()=>{draft+='\n';newlines+=1;},enter:async()=>{entered+=1;},verify:async()=>{}});
  assert.equal(draft,'/goal first line\nsecond line');
  assert.equal(newlines,1);assert.equal(entered,1);
});

test('Orca composer uses its separate draft field when rendered output excludes input', async () => {
  let draft='', entered=0;
  const read=async()=>({screen:'›\n model · Ready · context\n ? for shortcuts',draft});
  await submitNativeGoal({provider:'codex',objective:'first\nsecond',read,write:async text=>{draft+=text;},
    newline:async()=>{draft+='\n';},enter:async()=>{entered+=1;},verify:async()=>{}});
  assert.equal(draft,'/goal first\nsecond');assert.equal(entered,1);
});

test('Codex accepts the goal command menu when a narrow terminal hides the Ready label', async () => {
  let draft='', entered=0;
  const read=async()=>`› /goal  set or view the goal\n\n› ${draft || 'Ask Codex to do anything'}\n\n GPT-6-Luna low · ~/long/path…\n`;
  await submitNativeGoal({provider:'codex',objective:'finish',read,write:async text=>{draft+=text;},enter:async()=>{entered+=1;},verify:async()=>{}});
  assert.equal(entered,1);
});

test('long objectives avoid a folded paste burst before separate submission',async()=>{
 let draft='',last=0,entered=false;
 const objective='Read the immutable packets. '.repeat(15);
 await submitNativeGoal({provider:'codex',objective,read:async()=>({draft}),
  write:async text=>{if(text.length>128 || text.startsWith('Read') && Date.now()-last<100)throw Error('folded paste');draft+=text;last=Date.now();},
  verify:async()=>{},enter:async()=>{entered=true;}});
 assert.equal(draft,`/goal ${objective}`);assert.equal(entered,true);
});

test('structured drafts preserve exact whitespace before submission', async () => {
  let draft='', entered=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'a  b',read:async()=>({draft}),
    write:async text=>{draft+=text;draft=draft.replace('a  b','a\nb');},verify:async()=>{},enter:async()=>{entered+=1;}}),/did not settle/);
  assert.equal(entered,0);
});

test('Orca rendered empty composer may omit its trailing space',async()=>{
 let draft='',entered=false;
 await submitNativeGoal({provider:'codex',objective:'finish',read:async()=>`›${draft?' '+draft:''}\n model · Ready · context`,
  write:async text=>{draft+=text;},verify:async()=>{},enter:async()=>{entered=true;}});
 assert.equal(entered,true);
});
