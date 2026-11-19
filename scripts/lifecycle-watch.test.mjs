import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { effectArgsDigest as digest } from './lib/approvals.mjs';
import { createWatchStore, registerWatch, changeWatch, tickWatches, cleanupWatches, externalWatchConflict } from './lib/lifecycle-watch.mjs';
import { ensureWatchRunner, serveWatches } from './lib/lifecycle-watch-runner.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(),'lifecycle-watch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stateRoot = path.join(root,'work-state'), account = path.join(root,'account');
  const units = createUnitStateStore(stateRoot), goals = createContinuityStore(stateRoot);
  const recipient = {runtime:'cmux',sessionId:'surface-1',incarnationId:'surface-v1',cwd:root,
    worker:{executable:'/bin/codex',pid:42,incarnationId:'worker-v1',threadId:'thread-1'}};
  const custody = {unit:'change',ownership:'existing',owner:recipient};
  await units.create({schema:'harness.unit/1',unit:'change',kind:'chore',state:'Implementing',continuity:{goalId:'goal'}});
  await goals.create({goal:{id:'goal',objective:'done',criteria:['done'],remaining:['change'],status:'active'},
    policy:{runtime:'cmux',provider:'codex',account,model:'model',effort:'high',argv:['codex']},source:{path:path.join(root,'goal.md'),digest:digest('goal')}});
  await goals.transaction('goal',goal=>({...goal,revision:goal.revision+1,adoptions:[custody]}));
  let now = 1000, condition = {state:'pending',actionable:false}, ready = true, sent = 0, spawned = 0, status = 'gone', receipt = {state:'ready'}, submitError;
  const core = createAdapters();
  const io = {...core,backendFor:()=> 'codex-native-queue/1',host:()=> 'local-test-host',nowMs:()=>now,condition:async()=>condition,observe:async()=>({ready}),assertExclusive:async()=>{},
    withReceiver:async (watch,action)=>action(),claimReceiver:async()=>{},
    processIdentity:async()=>({status,incarnation:'runner-1'}),detach:async()=>{spawned++;status='live';return {pid:12345};},
    submit:async(watch,attempt)=>{
      const data = await createWatchStore(stateRoot,io).read(), stored = data.watches.find(item=>item.id===watch.id);
      assert.equal(stored.pending,attempt.key); assert.equal(stored.runs,1); assert.equal(stored.attempts[0].submitted,true);
      const ledger = await readFile(path.join(stateRoot,'units/change/ledger.ndjson'),'utf8'); assert.match(ledger,/session.wake/);
      sent++; if (submitError) throw new Error(submitError);
      receipt = {state:'queued'};
    },receipt:async()=>receipt};
  const request = {id:'watch',unit:'change',goalId:'goal',custodyDigest:digest(custody),recipient,account,
    everyMs:1000,maxRuns:3,expiresAt:100000,prompt:'Observe the changed condition and continue the approved work.',condition:{argv:['probe'],cwd:root}};
  const tick = ()=>tickWatches({stateRoot,io});
  const watch = async()=> (await createWatchStore(stateRoot,io).read()).watches[0];
  return {root,stateRoot,account,units,goals,recipient,request,io,tick,watch,
    add:()=>registerWatch({stateRoot,io,request}),advance:(ms=1000)=>{now+=ms;},change:value=>{condition=value;},busy:value=>{ready=!value;},
    counts:()=>({sent,spawned}),runner:value=>{status=value;},receipt:value=>{receipt=value;},failSubmit:()=>{submitError='transport dropped';}};
}

test('mechanical ticks use no model, wake once on change and preserve native receipt stages',async t=>{
  const f = await fixture(t); await f.add(); f.advance(); await f.tick(); assert.equal(f.counts().sent,0);
  f.change({state:'review-ready',actionable:true}); f.advance(); await f.tick(); assert.equal(f.counts().sent,1);
  assert.equal((await f.watch()).attempts[0].status,'transport-accepted');
  f.receipt({state:'started',turnId:'turn-1',turnStatus:'inProgress'}); await f.tick();
  assert.equal((await f.watch()).attempts[0].status,'turn-started');
  f.receipt({state:'started',turnId:'turn-1',turnStatus:'completed'}); await f.tick();
  assert.deepEqual((await f.watch()).attempts[0].result,{turnId:'turn-1',turnStatus:'completed'});
  f.advance(); await f.tick(); assert.equal(f.counts().sent,1);
});

test('Working, queued or nonempty composer defers change until receiver is ready',async t=>{
  const f = await fixture(t); await f.add(); f.change({state:'ci-passed',actionable:true}); f.busy(true);
  f.advance(); await f.tick(); assert.equal(f.counts().sent,0);
  f.busy(false); f.advance(); await f.tick(); assert.equal(f.counts().sent,1);
});

test('sleep coalesces occurrences, uncertain dispatch survives restart and never replays',async t=>{
  const f = await fixture(t); await f.add(); f.change({state:'ci-passed',actionable:true}); f.failSubmit();
  f.advance(50000); await f.tick(); const before = await f.watch();
  assert.equal(before.nextDue,52000); assert.equal(before.attempts[0].status,'uncertain');
  f.advance(); await tickWatches({stateRoot:f.stateRoot,io:{...f.io}}); assert.equal(f.counts().sent,1);
  await changeWatch({stateRoot:f.stateRoot,io:f.io,id:'watch',action:'reconcile'}); assert.equal(f.counts().sent,1);
  assert.equal((await f.watch()).pending,before.pending);
});

test('pause and HOLD persist across runner restart; explicit resume restores observation',async t=>{
  for (const action of ['pause','hold']) {
    const f = await fixture(t); await f.add(); await changeWatch({stateRoot:f.stateRoot,io:f.io,id:'watch',action});
    f.change({state:'ci-passed',actionable:true}); f.advance(); await tickWatches({stateRoot:f.stateRoot,io:{...f.io}});
    await ensureWatchRunner({stateRoot:f.stateRoot,io:f.io}); assert.deepEqual(f.counts(),{sent:0,spawned:0});
    await changeWatch({stateRoot:f.stateRoot,io:f.io,id:'watch',action:'resume'}); await f.tick(); assert.equal(f.counts().sent,1);
  }
});

test('changed custody, ended unit and expiry cannot wake a reused surface',async t=>{
  for (const reason of ['custody','unit','expiry','policy']) {
    const f = await fixture(t); await f.add(); f.change({state:'ready',actionable:true});
    if (reason === 'custody') await f.goals.transaction('goal',goal=>({...goal,revision:goal.revision+1,adoptions:[{unit:'change',owner:{...f.recipient,incarnationId:'replacement'}}]}));
    if (reason === 'policy') await f.goals.transaction('goal',goal=>({...goal,revision:goal.revision+1,policy:{...goal.policy,model:'changed-model'}}));
    if (reason === 'unit') await f.units.update('change',unit=>({...unit,state:'Closed'}));
    f.advance(reason === 'expiry' ? 100000 : 1000); await f.tick(); assert.equal(f.counts().sent,0);
    assert.equal((await f.watch()).status,reason === 'expiry' ? 'expired' : 'retired');
  }
});

test('concurrent ticks serialize intent/budget per receiver',async t=>{
  const f = await fixture(t); await f.add(); f.change({state:'ready',actionable:true}); f.advance();
  await Promise.all([f.tick(),f.tick()]); assert.equal(f.counts().sent,1); assert.equal((await f.watch()).runs,1);
  await assert.rejects(registerWatch({stateRoot:f.stateRoot,io:f.io,request:{...f.request,id:'second'}}),/already has a watch/);
});

test('registration requires exact current custody and finite budgets',async t=>{
  const f = await fixture(t);
  for (const patch of [{custodyDigest:digest('stale')},{maxRuns:0},{expiresAt:1000},{recipient:{...f.recipient,worker:{...f.recipient.worker,threadId:'reused'}}}]) {
    await assert.rejects(registerWatch({stateRoot:f.stateRoot,io:f.io,request:{...f.request,...patch}}));
  }
});

test('automatic startup reuses live runner and only recovers a provably gone owner',async t=>{
  const f = await fixture(t); await f.add();
  await Promise.all([ensureWatchRunner({stateRoot:f.stateRoot,io:f.io}),ensureWatchRunner({stateRoot:f.stateRoot,io:f.io})]);
  assert.equal(f.counts().spawned,1);
  const foreign = await ensureWatchRunner({stateRoot:f.stateRoot,io:{...f.io,host:()=> 'another-host'}});
  assert.equal(foreign.status,'unknown'); assert.equal(f.counts().spawned,1);
  f.runner('unknown'); await ensureWatchRunner({stateRoot:f.stateRoot,io:f.io}); assert.equal(f.counts().spawned,1);
  f.runner('gone'); await ensureWatchRunner({stateRoot:f.stateRoot,io:f.io}); assert.equal(f.counts().spawned,2);
});

test('runner shuts itself down when no runnable watches remain',async t=>{
  const f = await fixture(t); await f.add(); await ensureWatchRunner({stateRoot:f.stateRoot,io:f.io});
  await serveWatches({stateRoot:f.stateRoot,io:f.io,pid:12345,wait:async()=>{
    await changeWatch({stateRoot:f.stateRoot,io:f.io,id:'watch',action:'remove'});
  }});
  assert.equal((await createWatchStore(f.stateRoot,f.io).read()).runner,null);
});

test('cleanup removes only matching finalized receiver and preserves history and unrelated watches',async t=>{
  const f = await fixture(t); await f.add();
  await cleanupWatches({stateRoot:f.stateRoot,unit:'other',recipient:f.recipient,io:f.io}); assert.equal((await f.watch()).status,'active');
  await cleanupWatches({stateRoot:f.stateRoot,unit:'change',recipient:{...f.recipient,incarnationId:'other'},io:f.io}); assert.equal((await f.watch()).status,'active');
  await cleanupWatches({stateRoot:f.stateRoot,unit:'change',recipient:f.recipient,io:f.io}); assert.equal((await f.watch()).status,'removed');
});

test('external scheduler conflict is read-only, including paused definitions',async t=>{
  const f = await fixture(t), directory = path.join(f.root,'external','schedules'); await mkdir(directory,{recursive:true});
  const file = path.join(directory,'old.json'), definition = JSON.stringify({enabled:false,id:'old',target:{type:'codex-queue',thread:'thread-1',home:f.account}});
  await writeFile(file,definition);
  await assert.rejects(externalWatchConflict([path.dirname(directory)],f.request),/external scheduler owns/);
  assert.equal(await readFile(file,'utf8'),definition);
});

test('packaged native adapter wakes the original idle Codex thread through queue/add and protects drafts/Working',async t=>{
  const {createWatchIO} = await import('./lib/lifecycle-watch-io.mjs');
  const f = await fixture(t), thread = '11111111-1111-4111-8111-111111111111';
  const executable = path.join(f.root,'codex'), native = path.join(f.root,'native.json'), screenFile = path.join(f.root,'screen');
  await writeFile(path.join(f.root,'package.json'),'{"type":"commonjs"}');
  await writeFile(native,JSON.stringify({turns:[],queued:[],adds:0}));
  await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(!Object.hasOwn(r,'id'))return;
const file=${JSON.stringify(native)},data=JSON.parse(fs.readFileSync(file));let result={};
if(r.method==='hooks/list')result={data:[{cwd:${JSON.stringify(f.root)},errors:[],hooks:['sessionStart','stop'].map(eventName=>({eventName,pluginId:'forge-harness@forge-harness',source:'plugin',handlerType:'command',command:'/plugin/scripts/'+(eventName==='stop'?'continuity-stop':'policy-startup')+'-hook.mjs',enabled:true,async:false,trustStatus:data.hookTrust??'trusted',key:eventName,currentHash:eventName+'-hash'}))}]};
if(r.method==='thread/read') result={thread:{id:${JSON.stringify(thread)},cwd:${JSON.stringify(f.root)}}};
if(r.method==='thread/turns/list')result={data:data.turns,nextCursor:null};
if(r.method==='thread/queue/list')result={data:data.queued,nextCursor:null};
if(r.method==='thread/queue/add'){data.adds++;data.queued.push({clientUserMessageId:r.params.clientUserMessageId,input:r.params.input});fs.writeFileSync(file,JSON.stringify(data));result={};}
process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});
`,{mode:0o755});
  const stub = path.join(f.root,'inspect.cjs');
  await writeFile(stub,`const fs=require('node:fs');const [binary,...args]=process.argv.slice(2);let value;
if(binary==='cmux')value=args.includes('tree')?JSON.stringify({windows:[{id:'window',workspaces:[{id:'workspace',panes:[{surfaces:[{id:'surface-1',type:'terminal',tty:'tty1'}]}]}]}]}):fs.readFileSync(${JSON.stringify(screenFile)},'utf8');
else if(binary==='ps')value=args.includes('-t')?'42 42 42 '+${JSON.stringify(executable)}:'START';
else if(binary==='lsof')value=args.includes('-d')?'n'+${JSON.stringify(f.root)}+'\\n':'n'+${JSON.stringify(f.account)}+'/thread-writer-locks/'+${JSON.stringify(thread)}+'.lock\\n';
else throw Error('unexpected '+binary);process.stdout.write(value);
`);
  const core = createAdapters(), io = createWatchIO({env:{...process.env,AGENT_SCHEDULER_HOME:path.join(f.root,'empty-external')},
    core:{...core,command:(binary,args,options)=>core.command(process.execPath,binary===process.execPath?args:[stub,binary,...args],options)}});
  assert.equal(io.backendFor({worker:{executable}}),'codex-native-queue/1');
  assert.throws(()=>io.backendFor({worker:{executable:'unsupported-provider'}}),/only the verified/);
  const incarnation = 'tty1:42:START';
  const watch = {...f.request,stateRoot:f.stateRoot,recipient:{...f.recipient,incarnationId:incarnation,worker:{executable,pid:42,incarnationId:incarnation,threadId:thread}}};
  const screen = (draft='',status='Ready')=>`› ${draft}\n\n  GPT-6.1-Sol high · ~/work/product · ${status} · Context 30% left\n  ? for shortcuts\n`;
  await writeFile(screenFile,screen());
  assert.equal((await io.observe(watch)).ready,true);
  for (const rendered of [screen('user draft'),screen('','Working')]) {
    await writeFile(screenFile,rendered);
    let blocked = false;
    try { blocked = !(await io.observe(watch)).ready; } catch { blocked = true; }
    assert.equal(blocked,true);
    await assert.rejects(io.submit(watch,{key:'do-not-send'}));
  }
  assert.equal(JSON.parse(await readFile(native,'utf8')).adds,0);
  await writeFile(screenFile,screen());
  await writeFile(native,JSON.stringify({turns:[],queued:[],adds:0,hookTrust:'untrusted'}));
  await assert.rejects(io.submit(watch,{key:'untrusted'}),/not trusted/);
  assert.equal(JSON.parse(await readFile(native,'utf8')).adds,0);
  await writeFile(native,JSON.stringify({turns:[],queued:[],adds:0}));
  await io.submit(watch,{key:'once'});
  const data = JSON.parse(await readFile(native,'utf8'));
  assert.equal(data.adds,1); assert.equal(data.queued[0].clientUserMessageId,'once');
  assert.match(data.queued[0].input[0].text,/\[watch once\]$/);
  assert.equal((await io.receipt(watch,{key:'once'})).state,'queued');
  assert.equal((await io.observe(watch)).ready,false);
  await assert.rejects(io.submit(watch,{key:'second'}));
  assert.equal(JSON.parse(await readFile(native,'utf8')).adds,1);
  // Idle-only dispatch also fences a receiver that becomes busy inside the native query boundary.
  for (const busy of [{turns:[],queued:data.queued},{turns:[{status:'inProgress',items:[]}],queued:[]}]) {
    await writeFile(native,JSON.stringify({...busy,adds:1}));
    const result = await core.command(process.execPath,[path.resolve('scripts/codex-task-query.mjs')],{cwd:f.root,
      input:JSON.stringify({executable,operation:'queue',threadId:thread,cwd:f.root,prompt:'another request',clientId:'another',requireIdle:true})});
    assert.equal(result.exitCode,1); assert.match(result.stderr,/became busy/);
    assert.equal(JSON.parse(await readFile(native,'utf8')).adds,1);
  }
  // The same account/thread cannot be reserved in two state roots, even on another surface.
  await mkdir(path.join(watch.stateRoot,'watches'),{recursive:true});
  await writeFile(path.join(watch.stateRoot,'watches','store.json'),JSON.stringify({watches:[{...watch,status:'paused'}]}));
  await io.withReceiver(watch,()=>io.claimReceiver(watch));
  await assert.rejects(io.withReceiver(watch,()=>io.claimReceiver({...watch,stateRoot:path.join(f.root,'other-state'),id:'second'})),/another watch store/);
});

test('every public watch command and SessionStart recovery restarts missing runner without resuming pause',async t=>{
  const {runWatchCli} = await import('./lib/lifecycle-watch-cli.mjs');
  const {recoverWatchRunner} = await import('./policy-startup-hook.mjs');
  const f = await fixture(t); await f.add();
  const options = {'state-root':f.stateRoot};
  const result = await runWatchCli({positional:['unit','watch','list'],options,cwd:f.root,io:f.io});
  assert.match(result,/RESULT /); assert.equal(f.counts().spawned,1);
  f.runner('gone');
  await recoverWatchRunner({cwd:f.root,io:{...f.io,command:async()=>({exitCode:0,stdout:path.dirname(f.stateRoot)+'\n'})}});
  assert.equal(f.counts().spawned,2);
  // Explicit root recovery uses the same Git common-dir/work-state convention.
  await runWatchCli({positional:['unit','watch','status'],options,cwd:f.root,io:f.io});
  assert.equal(f.counts().spawned,2);
  await runWatchCli({positional:['unit','watch','pause','watch'],options,cwd:f.root,io:f.io});
  f.runner('gone'); await runWatchCli({positional:['unit','watch','status'],options,cwd:f.root,io:f.io});
  assert.equal(f.counts().spawned,2); assert.equal((await f.watch()).status,'paused');
});

test('daemon advisory lock admits only one runner and empty/expired store stops without a host service',async t=>{
  const f = await fixture(t); await f.add(); await ensureWatchRunner({stateRoot:f.stateRoot,io:f.io});
  const held = await f.io.stateLock(path.join(f.stateRoot,'watches','.runner.lock'),{wait:false});
  try { await serveWatches({stateRoot:f.stateRoot,io:f.io,pid:12345,wait:async()=>assert.fail('second runner must not tick')}); }
  finally { await held.close(); }
  f.advance(100000);
  await serveWatches({stateRoot:f.stateRoot,io:f.io,pid:12345,wait:async()=>assert.fail('expired store must exit')});
  assert.equal((await f.watch()).status,'expired'); assert.equal((await createWatchStore(f.stateRoot,f.io).read()).runner,null);
});

test('finite budget is preserved across ticks and prevents a second changed-state attempt',async t=>{
  const f = await fixture(t); await registerWatch({stateRoot:f.stateRoot,io:f.io,request:{...f.request,maxRuns:1}});
  f.change({state:'review-ready',actionable:true}); f.advance(); await f.tick();
  f.receipt({state:'started',turnId:'turn',turnStatus:'completed'}); await f.tick();
  f.change({state:'review-updated',actionable:true}); f.advance(); await f.tick();
  assert.equal(f.counts().sent,1); assert.equal((await f.watch()).status,'exhausted');
});

test('bundled detached runner starts automatically, shares one instance and exits after last removal',async t=>{
  const {createWatchIO} = await import('./lib/lifecycle-watch-io.mjs');
  const f = await fixture(t); await f.add();
  const io = createWatchIO(), store = createWatchStore(f.stateRoot,io), initial = Date.now();
  await store.transaction(async(data,save)=>{
    const watch = data.watches[0];
    watch.expiresAt = initial+30000; watch.nextDue = initial;
    watch.condition = {argv:[process.execPath,'-e','console.log(JSON.stringify({state:"pending",actionable:false}))'],cwd:f.root};
    await save();
  });
  const runner = await ensureWatchRunner({stateRoot:f.stateRoot,io});
  t.after(async()=>{try{process.kill(runner.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
  const second = await ensureWatchRunner({stateRoot:f.stateRoot,io}); assert.equal(second.pid,runner.pid);
  async function until(predicate) {
    const deadline = Date.now()+15000;
    while (Date.now()<deadline) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,30)); }
    assert.fail('detached runner did not reach expected lifecycle state');
  }
  await until(async()=>{
    const data = await store.read(); return data.runner?.incarnation && data.watches[0].nextDue > initial;
  });
  assert.equal((await store.read()).watches[0].runs,0);
  await changeWatch({stateRoot:f.stateRoot,io,id:'watch',action:'remove'});
  await until(async()=> (await store.read()).runner === null);
});

test('pending wake participates in custody fences until native turn start without claiming unit completion',async t=>{
  const {createLedgerStore,unresolvedEffect} = await import('./lib/ledger.mjs');
  const f = await fixture(t); await f.add();
  f.change({state:'pending',actionable:true}); f.advance(); await f.tick(); assert.equal(f.counts().sent,0);
  f.change({state:'review-ready',actionable:true}); f.advance(); await f.tick();
  const ledger = createLedgerStore(f.stateRoot);
  assert.equal((await ledger.withLock('change',async rows=>unresolvedEffect(await rows.read()))).effect,'session.wake');
  // Completion reservations must not prevent read-only reconciliation of the original wake.
  await f.goals.transaction('goal',goal=>({...goal,revision:goal.revision+1,completionReservation:{proof:'reserved'}}));
  f.receipt({state:'started',turnStatus:'inProgress',turnId:'native-turn'}); await f.tick();
  assert.equal(await ledger.withLock('change',async rows=>unresolvedEffect(await rows.read())),undefined);
  assert.equal((await f.units.read('change')).state,'Implementing'); assert.ok((await f.watch()).pending);
});

test('explicit policy deny fences watch registration and dispatch',async t=>{
  const f = await fixture(t);
  const deny = unit=>({...unit,policy:{goal:{class:'task'},authority:{deny:['session.wake']}}});
  await f.units.update('change',deny); await assert.rejects(f.add(),/policy deny/);
  await f.units.update('change',unit=>({...unit,policy:{goal:{class:'task'}}})); await f.add();
  await f.units.update('change',deny); f.change({state:'changed',actionable:true}); f.advance(); await f.tick();
  assert.equal(f.counts().sent,0); assert.equal((await f.watch()).runs,0); assert.match((await f.watch()).error.message,/policy deny/);
});

test('actual goal blockers become durable HOLD and require explicit resume after source recovery',async t=>{
  const f = await fixture(t); await f.add();
  await f.goals.transaction('goal',goal=>({...goal,revision:goal.revision+1,goal:{...goal.goal,status:'blocked',
    blocker:{unit:'change',reason:'external decision',resumeCondition:'approved',evidence:'decision-source'}}}));
  f.change({state:'ready',actionable:true}); f.advance(); await f.tick();
  assert.equal((await f.watch()).status,'HOLD'); assert.equal(f.counts().sent,0);
  await f.goals.transaction('goal',goal=>{const {blocker,...previous}=goal.goal;return {...goal,revision:goal.revision+1,goal:{...previous,status:'active'}};});
  await f.tick(); assert.equal(f.counts().sent,0);
  await changeWatch({stateRoot:f.stateRoot,io:f.io,id:'watch',action:'resume'}); await f.tick(); assert.equal(f.counts().sent,1);
});

test('external scheduler roots survive restart with a different environment',async t=>{
  const {createWatchIO} = await import('./lib/lifecycle-watch-io.mjs');
  const f = await fixture(t), external = path.join(f.root,'external-store');
  f.io.externalRoots = [external]; await f.add();
  await mkdir(path.join(external,'schedules'),{recursive:true});
  await writeFile(path.join(external,'schedules','existing.json'),JSON.stringify({target:{type:'codex-queue',thread:'thread-1',home:f.account}}));
  const restarted = createWatchIO({env:{AGENT_SCHEDULER_HOME:path.join(f.root,'different-store')}});
  await assert.rejects(restarted.assertExclusive(await f.watch()),/external scheduler owns/);
});
