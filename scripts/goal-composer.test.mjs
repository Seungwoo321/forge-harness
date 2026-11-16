import test from 'node:test';
import assert from 'node:assert/strict';
import { submitNativeGoal, classifyNativeGoalDraft, nativeComposerContents } from './lib/goal-composer.mjs';

const statusFooter = 'GPT-6.1-Sol high · ~/work/repository/long-product-directory · fix/maintenance-change · Ready · Context 100% left · weekly 20% left';
function wrappedStatusScreen(draft, width = 80, footer = statusFooter, hint = '← for agents · ? for shortcuts') {
 const rows=[];
 for(let offset=0;offset<footer.length;offset+=width-2)rows.push('  '+footer.slice(offset,offset+width-2));
 return ` >_ OpenAI Codex (v0.169.0)\n› ${draft.replaceAll('\n','\n  ')}\n \n${rows.join('\n')}\n  ${hint}\n`;
}

test('AC-1 wrapped native status footers preserve exact empty and multiline composer contents',()=>{
 for(const footer of [statusFooter,statusFooter+' · 475K window · 262K used',statusFooter+' · 475K window · 75.4K used'])
 for(const width of [40,80,149,240])for(const draft of ['Ask Codex to do anything','Ask Codex to do anything ','/goal Read packet/path\nwith  exact spaces','/goal finish ','/goal finish\n','/goal finish\n\n','(']) {
  const view=wrappedStatusScreen(draft,width,footer);
  assert.equal(nativeComposerContents(view,'codex'),draft);
  assert.equal(nativeComposerContents(view.replace('  ← for agents · ? for shortcuts\n',''),'codex'),draft);
  assert.equal(classifyNativeGoalDraft(view,'codex','Read packet/path\nwith  exact spaces'),draft==='/goal Read packet/path\nwith  exact spaces'?'exact':'other');
 }
 for(const hint of ['← for agents · ? for shortcuts    Pursuing goal (2m)','← for agents · ? for shortcuts    ⚠ 1 warning · f2 to view','← for agents · ? for shortcuts    Pursuing goal (1h 2m) · ⚠ 4 warnings · f2 to view'])
  assert.equal(nativeComposerContents(wrappedStatusScreen('/goal finish ',80,statusFooter,hint),'codex'),'/goal finish ');
});

test('AC-2 native submission preserves real and footer-like drafts and refuses ambiguous footer tails',async()=>{
 for(const draft of ['/goal finish ','/goal finish\n','/goal finish\n\n']) {
  const view=wrappedStatusScreen(draft);
  assert.notEqual(classifyNativeGoalDraft(view,'codex','finish'),'exact');
  let writes=0,enters=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',resumeDraft:true,read:async()=>view,
   verify:async()=>{},write:async()=>{writes++;},enter:async()=>{enters++;}}));
  assert.equal(writes,0);assert.equal(enters,0);
 }
 for(const footer of [statusFooter,statusFooter+' · 475K window · 262K used'])
 for(const draft of ['(','foreign draft','Ask Codex to do anything ','Ask Codex to do anything\n','Ask Codex to do anything\n\n','Ask Codex to do anything\n'+statusFooter,'/goal different\nmodel · Ready · context']) {
  let writes=0,enters=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',read:async()=>wrappedStatusScreen(draft,80,footer),
   verify:async()=>{},write:async()=>{writes++;},enter:async()=>{enters++;}}));
  assert.equal(writes,0);assert.equal(enters,0);
 }
 for(const ambiguous of [wrappedStatusScreen('Ask Codex to do anything').replace('  ← for agents','  foreign tail\n  ← for agents'),wrappedStatusScreen('Ask Codex to do anything')+'foreign tail\n',
  wrappedStatusScreen('Ask Codex to do anything').replace('  ← for agents · ? for shortcuts\n','')+'foreign tail\n',
  ...['← for agents · ? for shortcuts · foreign tail','foreign tail · ← for agents · ? for shortcuts'].map(hint=>wrappedStatusScreen('Ask Codex to do anything',80,statusFooter,hint))]) {
 let writes=0,enters=0;
 await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',read:async()=>ambiguous,
  verify:async()=>{},write:async()=>{writes++;},enter:async()=>{enters++;}}));
 assert.equal(writes,0);assert.equal(enters,0);
 }
});

test('Orca UI-only soft wraps preserve the complete original goal and reject altered, extra or partial text',async()=>{
 const objective='Read the approved goal packet/path and preserve its exact checksum.';
 const full='/goal '+objective;
 const wrapped='/goal Read the approved goal\npacket/path and preserve its exact\nchecksum.';
 const screen=renderedDraft=>({screen:' >_ OpenAI Codex (v0.169.0)\n›\n model · Ready · context\n ? for shortcuts',renderedDraft});
 assert.equal(classifyNativeGoalDraft(screen(wrapped),'codex',objective),'exact');
 for(const draft of [wrapped.replace('packet/path','packetpath'),wrapped+' foreign',wrapped.replace('approved','different'),wrapped.slice(6),wrapped.slice(0,-1),wrapped+'\n',wrapped.replace('\n','\n\n')])assert.notEqual(classifyNativeGoalDraft(screen(draft),'codex',objective),'exact');
 let confirmations=0,enters=0;
 await submitNativeGoal({provider:'codex',objective,read:async()=>screen(wrapped),resumeDraft:true,preTurn:{platform:'codex/0.169.0'},
  write:async()=>{throw Error('An exact pending goal must never be typed again');},beforeWrite:async()=>{throw Error('An existing submission must not repeat');},verify:async()=>{},beforeEnter:async()=>{confirmations++;},enter:async check=>{await check();enters++;}});
 assert.equal(confirmations,1);assert.equal(enters,1);assert.notEqual(full,wrapped);
});

test('Korean full drafts preserve slash identity across wide wraps and reject clipped or foreign text',()=>{
 const objective='Goal: 승인 범위 검증; 패키지/그룹 중단; 실패/생략과 로그/산출물 보존. Read packet/path (sha256:abcdef).';
 const chars=[...` ${objective}`],damaged='/goal'+chars.slice(0,128).join('').replaceAll('/','')+chars.slice(128).join('');
 const render=text=>{let column=0,lines=[''];for(const char of text){const width=/[가-힣]/u.test(char)?2:1;if(column+width>32){lines.push('');column=0;}lines[lines.length-1]+=char;column+=width;}return `› ${lines.join('\n  ')}\n model · Ready · context`;};
 assert.equal(classifyNativeGoalDraft(render(`/goal ${objective}`),'codex',objective),'exact');
 assert.equal(classifyNativeGoalDraft(render(damaged),'codex',objective),'slash-loss');
 assert.equal(classifyNativeGoalDraft(render(damaged+' foreign'),'codex',objective),'other');
 assert.equal(classifyNativeGoalDraft(render(`/goal ${objective}`.slice(10)),'codex',objective),'other');
 const boundary='A'.repeat(127)+'/tail';assert.equal(classifyNativeGoalDraft(render(`/goal ${boundary.replace('/','')}`),'codex',boundary),'other');
});

test('multiline slash loss affects only the initial logical-line burst and keeps full packet text',()=>{
 const objective='Goal: 승인 패키지/그룹과 실패/생략\n\nRead packet/one and checksum/first\nRead packet/two and checksum/second';
 const damaged='/goal '+objective.replace('패키지/그룹','패키지그룹').replace('실패/생략','실패생략');
 const screen=text=>`› ${text.replaceAll('\n','\n  ')}\n model · Ready · context`;
 assert.equal(classifyNativeGoalDraft(screen(damaged),'codex',objective),'slash-loss');
 assert.equal(classifyNativeGoalDraft(screen(damaged.replace('packet/one','packetone')),'codex',objective),'other');
 assert.equal(classifyNativeGoalDraft(screen('/goal '+objective),'codex',objective),'exact');
});

test('first argument must flush visibly before a Korean objective can reach slash-popup dispatch',async()=>{
 const objective='Goal: 한글 패키지/그룹과 실패/생략, 로그/산출물 전체 원문';
 let draft='',pending='',prefixReads=0,entered=0,bulkBeforeSettle=false;
 const read=async()=>{if(pending&&++prefixReads>=3){draft+=pending;pending='';}return `› ${draft||'Ask Codex to do anything'}\n model · Ready · context`;};
 await submitNativeGoal({provider:'codex',objective,read,verify:async()=>{},
  write:async text=>{if(draft==='/goal'&&!pending){pending=text;return;}if(pending){bulkBeforeSettle=true;pending+=text.replaceAll('/','');return;}draft+=text;},
  enter:async()=>{entered++;}});
 assert.equal(bulkBeforeSettle,false);assert.equal(draft,`/goal ${objective}`);assert.equal(entered,1);assert.ok(prefixReads>=3);
});

test('first-input proof rejects clipped, prior-input, pending and startup views before recording submission',async()=>{
 const fresh=' >_ OpenAI Codex (v0.167.0)\n';
 const ready='› Ask Codex to do anything\n model · Ready · context\n ? for shortcuts';
 for(const screen of [ready, fresh.replace('0.167.0','0.167.1')+ready, fresh+'› prior user input\n'+ready,...['Messages to be submitted after next tool call','Messages to be submitted at end of turn','Queued follow-up inputs','edit last queued message','Waiting for startup','Preparing images','pending approval','Review plugin hooks'].map(line=>fresh+line+'\n'+ready),fresh+'› foreign draft\n model · Ready · context']) {
  let marks=0,writes=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',preTurn:true,read:async()=>screen,verify:async()=>{},beforeWrite:async()=>{marks++;},write:async()=>{writes++;},enter:async()=>{}}));
  assert.equal(marks,0);assert.equal(writes,0);
 }
});

test('fresh queue/goal proof is rechecked after owner probes at first input and Return',async()=>{
 for(const boundary of ['first','enter']) {
  let draft='',blocked=false,entered=0,writes=0;
  const read=async()=>` >_ OpenAI Codex (v0.167.0)\n› ${draft||'Ask Codex to do anything'}\n model · Ready · context`;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',preTurn:true,read,
   verify:async()=>{if(blocked)throw Error('native queue changed');},
   write:async(text,beforeInput)=>{if(boundary==='first'&&beforeInput)blocked=true;await beforeInput?.();writes++;draft+=text;},
   enter:async beforeInput=>{blocked=true;await beforeInput();entered++;}}),/native queue changed/);
  assert.equal(entered,0);if(boundary==='first')assert.equal(writes,0);
 }
});

test('AC-2 fresh supported input requires its exact supported platform and matching native welcome',async()=>{
 for(const [platform,welcome,allowed] of [['0.169.0','0.169.0',true],['0.169.1','0.169.1',false],['0.170.0','0.170.0',false],['0.169.0-custom','0.169.0-custom',false],['0.169.0','0.168.0',false],['0.168.0','0.169.0',false],['0.168.0','0.168.0',true],['0.168.1','0.168.1',false],['0.168.0','0.167.1',false]]) {
  let draft='',entered=0,writes=0;
  const read=async()=>` >_ OpenAI Codex (v${welcome})\n› ${draft||'Ask Codex to do anything'}\n model · Ready · context\n ? for shortcuts`;
  const run=()=>submitNativeGoal({provider:'codex',objective:'finish',preTurn:{platform:`codex/${platform}`},read,
   verify:async()=>{},write:async text=>{writes++;draft+=text;},enter:async()=>{entered++;}});
  if(allowed){await run();assert.equal(draft,'/goal finish');assert.equal(entered,1);}
  else {await assert.rejects(run(),/fresh native receiver view is unverified/);assert.equal(writes,0);assert.equal(entered,0);}
 }
});

test('native goal is typed as a command and separately submitted after the composer settles', async () => {
  for (const provider of ['codex','claude']) {
    let draft = '', entered = 0;
    const writes = [];
    const screen = () => provider === 'codex'
      ? `› ${draft || 'Ask Codex to do anything'}\n\n model · Ready · context\n ? for shortcuts`
      : `────────────\n❯ ${draft || 'Try "example"'}\n────────────\n shift+tab`;
    await submitNativeGoal({provider,objective:'finish the work',read:async()=>screen(),write:async text=>{writes.push(text);draft+=text;},enter:async()=>{entered+=1;},verify:async()=>{}});
    assert.deepEqual(writes,provider==='codex'?['/','goal',' f','inish the work']:['/','goal',' finish the work']);
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

test('a long objective that scrolls the Claude composer is still submitted once its visible tail settles', async () => {
  let draft='', entered=0;
  const width=30, visible=3;
  const read=async()=>{
    if (!draft) return `────────────\n❯ Try "example"\n────────────\n shift+tab`;
    const rows=[]; for (let i=0;i<draft.length;i+=width) rows.push(draft.slice(i,i+width));
    const shown=rows.slice(-visible);
    return `────────────\n❯ ${shown[0]}\n${shown.slice(1).map(r=>`  ${r}`).join('\n')}\n────────────\n shift+tab`;
  };
  const objective='Finish the unit with gates, review and handoff, then read the immutable packet references in full.';
  await submitNativeGoal({provider:'claude',objective,read,write:async text=>{draft+=text;},enter:async()=>{entered+=1;},verify:async()=>{}});
  assert.equal(draft,`/goal ${objective}`);assert.equal(entered,1);
  // A clipped view of different text is still rejected.
  draft=''; let wrong=0;
  await assert.rejects(submitNativeGoal({provider:'claude',objective,read:async()=>draft ? `────────────\n❯ ${draft==='/goal'?'/goal':'something else entirely'}\n────────────\n shift+tab` : `────────────\n❯ \n────────────\n shift+tab`,
    write:async text=>{draft+=text;},enter:async()=>{wrong+=1;},verify:async()=>{}}));
  assert.equal(wrong,0);
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

test('a draft or modal appearing during durable fence persistence prevents the first native input',async()=>{
 for(const replacement of ['user note','modal']) {
  let draft='',writes=0;
  const read=async()=>replacement==='modal'&&draft==='modal'?'Review hooks':`› ${draft}\n model · Ready · context`;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',recovery:true,read,verify:async()=>{},
   beforeWrite:async()=>{await Promise.resolve();draft=replacement;},write:async text=>{writes++;draft+=text;},enter:async()=>{}}));
  assert.equal(writes,0);
 }
});

test('recovery requires rendered Ready and rechecks the composer after native identity probes',async()=>{
 for(const screen of [{draft:''},'› \n model · Working · context','› old prompt\n model · Ready · context\n› \n model · Working · context']) {
  let marks=0;
  await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',recovery:true,read:async()=>screen,verify:async()=>{},
   beforeWrite:async()=>{marks++;},write:async()=>{},enter:async()=>{}}),/Ready/);
  assert.equal(marks,0);
 }
 let draft='',writes=0;
 await assert.rejects(submitNativeGoal({provider:'codex',objective:'finish',recovery:true,read:async()=>`› ${draft}\n model · Ready · context`,verify:async()=>{},
  write:async(_text,check)=>{draft='foreign draft';await check();writes++;},enter:async()=>{}}),/another draft/);
 assert.equal(writes,0);
});
