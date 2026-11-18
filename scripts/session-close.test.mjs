import test from 'node:test';
import assert from 'node:assert/strict';
import {effectArgsDigest} from './lib/approvals.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRunner } from './lib/session-runtime.mjs';
import {createLedgerStore,executeEffect} from './lib/ledger.mjs';

function fixture(options = {}) {
  let present = options.present ?? true;
  let workspacePresent = true;
  let stale = 0;
  let attempted = false;
  let marked = false;
  let closes = 0;
  let workspaceCloses = 0;
  let trees = 0;
  const title = options.foreign ? 'my workspace' : `handoff-${'a'.repeat(64)}`;
  const owner = {sessionId:'owner',workspaceId:'workspace',cwd:'/work/product',incarnationId:'tty1:11:START',tty:'tty1',
    worker:{executable:'worker',incarnationId:'tty1:11:START',pid:11,threadId:'native-owner'}};
  const recipient = {sessionId:'receiver',cwd:'/work/product',incarnationId:'tty2:22:START',executable:'worker'};
  const submission = {async mark(binding) { this.binding=structuredClone(binding); this.attempted=true; marked=true; }};
  const input = {effect:'session.close',key:'close-key',args:{owner,recipient,session:'owner',incarnation:owner.incarnationId},submission};
  const others = [...(options.others ?? [])];
  const command = async (binary,args) => {
    let stdout = '';
    if (binary === 'cmux' && args.includes('tree')) {
      trees++;
      if (options.malformed) return {exitCode:0,stdout:JSON.stringify(options.malformed)};
      if (attempted && stale-- <= 0 && !options.failed) { present=false; if (workspaceCloses && !options.residual) workspacePresent=false; }
      const surfaces = [...(present?[{id:'owner',type:'terminal',tty:'tty1'}]:[]),...others,
        ...(marked && options.race?[{id:'user-added',type:options.race}]:[])];
      const routeChanged = marked && options.routeDrift;
      stdout=JSON.stringify({windows:[{id:routeChanged?'other-window':'window',workspaces:[
        ...(workspacePresent?[{id:'workspace',title:marked && options.titleDrift?'changed title':title,panes:[{surfaces,
          ...(options.badCount?{surface_count:surfaces.length+1}:{})}]}]:[]),
        {id:'receiver-workspace',panes:[{surfaces:[{id:'receiver',type:'terminal',tty:'tty2'}]}]},
      ]}]});
    } else if (binary === 'cmux' && (args.includes('close-workspace') || args.includes('close-surface'))) {
      assert.equal(args[args.indexOf('--workspace')+1],'workspace');
      attempted=true; stale=options.stale ?? 0;
      if (args.includes('close-workspace')) workspaceCloses++; else {closes++;assert.equal(args[args.indexOf('--surface')+1],'owner');}
      if (options.failed || options.lost) return {exitCode:1,stdout:''};
    } else if (binary === 'ps') {
      if (args.includes('tty=')) stdout=options.caller?'tty1':'??';
      else if (args.includes('pid=,pgid=,tpgid=,comm=')) stdout=args.includes('tty2')?'22 22 22 worker\n':'11 11 11 worker\n';
      else stdout=(options.reused || marked && options.processDrift) && args.includes('11')
        || options.recipientDrift && args.includes('22')?'CHANGED':'START';
    } else if (binary === 'lsof') stdout='p11\nn/work/product\n';
    else throw Error(`unexpected ${binary} ${args.join(' ')}`);
    return {exitCode:0,stdout};
  };
  const makeRunner = () => createSessionRunner({runtime:'cmux',command,parent:{...owner,closable:!options.orchestrator},
    launch:()=>['worker'],pollAttempts:options.pollAttempts ?? 1,
    taskTransport:{async identity(){return {threadId:options.threadDrift || marked && options.lateThreadDrift?'changed-thread':'native-owner'};}}});
  return {runner:makeRunner(),makeRunner,input,submission,others,
    state:()=>({present,workspacePresent,closes,workspaceCloses,trees})};
}

for (const key of ['orchestrator','caller','reused','recipientDrift','threadDrift','processDrift','lateThreadDrift','routeDrift','titleDrift']) {
  test(`native close rejects ${key} before mutation (AC-2)`,async()=>{
    const f=fixture({[key]:true}); await assert.rejects(f.runner.execute(f.input));
    assert.equal(f.state().closes+f.state().workspaceCloses,0);
  });
}

test('exclusive managed workspace closes directly without a replacement shell (AC-1)',async()=>{
  const f=fixture(); const result=await f.runner.execute(f.input);
  assert.equal(result.closed,true); assert.equal(result.closure.target.kind,'workspace');
  assert.equal(f.submission.attempted,true);
  assert.equal(f.state().workspacePresent,false); assert.equal(f.state().workspaceCloses,1); assert.equal(f.state().closes,0);
  assert.equal((await f.makeRunner().verify({...f.input,submission:undefined,priorResult:result})).status,'completed');
});

for (const type of ['terminal','browser','dock','unknown']) {
  test(`shared ${type} content is preserved through exact surface closure and replay (AC-2 AC-3)`,async()=>{
    const others=[{id:'user-content',type,tty:'tty4'}]; const f=fixture({others});
    assert.equal((await f.runner.execute(f.input)).closed,true);
    assert.equal(f.state().workspacePresent,true);assert.equal(f.state().workspaceCloses,0);assert.equal(f.state().closes,1);
    assert.deepEqual(f.others,others);assert.equal((await f.makeRunner().verify(f.input)).status,'completed');
  });
}

test('foreign last-surface workspace is preserved without creating a surface (AC-2)',async()=>{
  const f=fixture({foreign:true});assert.equal((await f.runner.execute(f.input)).closed,true);
  assert.equal(f.state().workspaceCloses,0);assert.equal(f.state().workspacePresent,true);assert.equal(f.state().closes,1);
});

test('new shared content before mutation rejects workspace closure (AC-2)',async()=>{
  const f=fixture({race:'browser'});await assert.rejects(f.runner.execute(f.input));
  assert.equal(f.state().workspaceCloses+f.state().closes,0);assert.equal((await f.runner.verify(f.input)).status,'unknown');
});

for (const malformed of [{},{windows:[]},{windows:[{}]},{windows:[{id:'w',workspaces:[{id:'x',panes:[{}]}]}]},
  {windows:[{id:'w',workspaces:[{id:'x',panes:[{surfaces:[{id:'x',type:'browser'},{id:'x',type:'terminal'}]}]}]}]}]) {
  test('incomplete or ambiguous close inventory cannot authorize mutation or success (AC-2)',async()=>{
    const f=fixture({malformed});await assert.rejects(f.runner.execute(f.input));assert.equal((await f.runner.verify(f.input)).status,'unknown');
    assert.equal(f.state().closes+f.state().workspaceCloses,0);
  });
}

test('inconsistent surface count rejects close (AC-2)',async()=>{
  const f=fixture({badCount:true});await assert.rejects(f.runner.execute(f.input));assert.equal(f.state().workspaceCloses,0);
});

test('permanent malformed inventory fails immediately without disappearance polling (AC-2 AC-4)',async()=>{
  const f=fixture({malformed:{},pollAttempts:3});
  assert.equal((await f.runner.verify(f.input)).status,'unknown');
  assert.equal(f.state().trees,1);assert.equal(f.state().workspaceCloses+f.state().closes,0);
});

test('permanent owner identity failures are not polled as delayed disappearance (AC-2)',async()=>{
  const once=fixture({reused:true,pollAttempts:1}),bounded=fixture({reused:true,pollAttempts:3});
  assert.equal((await once.runner.verify(once.input)).status,'unknown');
  assert.equal((await bounded.runner.verify(bounded.input)).status,'unknown');
  assert.equal(bounded.state().trees,once.state().trees);
});

test('delayed inventory is polled until actual workspace disappearance (AC-1 AC-3)',async()=>{
  const f=fixture({stale:1,pollAttempts:2});assert.equal((await f.runner.execute(f.input)).closed,true);
  assert.equal(f.state().workspacePresent,false);assert.equal(f.state().workspaceCloses,1);
});

test('remaining workspace never proves full cleanup after owner disappears (AC-3)',async()=>{
  const f=fixture({residual:true});await assert.rejects(f.runner.execute(f.input));
  assert.equal(f.state().present,false);assert.equal(f.state().workspacePresent,true);
  assert.equal((await f.makeRunner().verify(f.input)).status,'unknown');
  assert.equal((await f.makeRunner().verify({...f.input,submission:undefined})).status,'unknown');
  assert.equal(f.state().workspaceCloses,1);
});

test('unbound legacy owner disappearance with a residual managed workspace is unknown (AC-3)',async()=>{
  const f=fixture({present:false});assert.equal((await f.runner.verify(f.input)).status,'unknown');
  assert.equal(f.state().workspaceCloses+f.state().closes,0);
});

test('attempted failed closure stays unknown and never repeats a destructive command (AC-3)',async()=>{
  const f=fixture({failed:true});await assert.rejects(f.runner.execute(f.input));
  assert.equal((await f.runner.verify(f.input)).status,'unknown');await assert.rejects(f.runner.execute(f.input));
  assert.equal(f.state().workspaceCloses,1);
});

test('changed original close arguments reject saved target proof (AC-2 AC-3)',async()=>{
  const f=fixture();await f.runner.execute(f.input);
  assert.equal((await f.runner.verify({...f.input,args:{...f.input.args,resultDigest:'another-result'}})).status,'unknown');
});

test('foreign workspace bindings and prior results never prove original cleanup (AC-2 AC-3)',async()=>{
  for (const kind of ['workspace','surface']) {
    const f=fixture({present:false});
    const closure={runtime:'cmux',argsDigest:effectArgsDigest(f.input.args),target:{kind,
      id:kind==='workspace'?'foreign-workspace':'owner',workspaceId:'foreign-workspace',windowId:'window',title:`handoff-${'a'.repeat(64)}`}};
    for (const proof of [{submission:{attempted:true,binding:closure}},{submission:undefined,priorResult:{closed:true,closure}}]) {
      assert.equal((await f.runner.verify({...f.input,...proof})).status,'unknown');
      await assert.rejects(f.runner.execute({...f.input,...proof}));
    }
    assert.equal(f.state().workspaceCloses+f.state().closes,0);
  }
});

test('ledger rejects a close target for another workspace before mutation (AC-2 AC-3)',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'session-close-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=fixture();const store=createLedgerStore(root);let mutations=0;
  const input={unit:'forged',effect:'session.close',args:f.input.args,
    policy:{goal:{class:'task'},authority:{allow:[],deny:[]},delivery:'none'},context:{explicitUserInstruction:true,productOwned:true},store,
    adapter:{now:()=> '2026-01-01T00:00:00.000Z',verify:async()=>({status:'unknown'}),async execute(effect){
      await effect.submission.mark({runtime:'cmux',argsDigest:effectArgsDigest(effect.args),target:{kind:'workspace',
        id:'foreign-workspace',workspaceId:'foreign-workspace',windowId:'window',title:`handoff-${'a'.repeat(64)}`}});
      mutations++;return {closed:true};
    }}};
  assert.equal((await executeEffect(input)).status,'uncertain');assert.equal(mutations,0);
  assert.equal((await store.withLock('forged',l=>l.read())).filter(row=>row.event==='submission').length,0);
});

test('focused closure regression reconciles lost responses through the ledger in a new runner (AC-3 AC-4)',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'session-close-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for (const shared of [false,true]) {
    const f=fixture({lost:true,others:shared?[{id:'user-browser',type:'browser'}]:[],stale:1,pollAttempts:2});
    const store=createLedgerStore(root);let runner=f.runner;
    const effect={unit:shared?'shared':'exclusive',effect:'session.close',args:f.input.args,
      policy:{goal:{class:'task'},authority:{allow:[],deny:[]},delivery:'none'},context:{explicitUserInstruction:true,productOwned:true},store,
      adapter:{now:()=> '2026-01-01T00:00:00.000Z',execute:input=>runner.execute(input),verify:input=>runner.verify(input)}};
    assert.equal((await executeEffect(effect)).status,'uncertain'); runner=f.makeRunner();
    const reconciled=await executeEffect(effect);assert.equal(reconciled.status,'reconciled');assert.equal(reconciled.result.closed,true);
    assert.equal((await executeEffect(effect)).status,'duplicate');
    assert.equal(f.state().workspaceCloses+f.state().closes,1);
    const rows=await store.withLock(effect.unit,l=>l.read());
    assert.equal(rows.filter(row=>row.event==='intent').length,1);assert.equal(rows.filter(row=>row.event==='submission').length,1);
    assert.equal(rows.find(row=>row.event==='submission').binding.target.kind,shared?'surface':'workspace');
  }
});
test('native recipient observation resolves the recipient account separately from the reviewer account',async()=>{
  const threadId='11111111-1111-4111-8111-111111111111';
  const command=async(binary,args)=>{
    let stdout;
    if(binary==='cmux') stdout=JSON.stringify({windows:[{id:'window',workspaces:[{id:'work',panes:[{surfaces:[{id:'recipient',type:'terminal',tty:'tty2'}]}]}]}]});
    else if(binary==='ps') stdout=args.includes('pid=,pgid=,tpgid=,comm=') ? '22 22 22 codex\n' : 'START';
    else if(binary==='lsof') stdout=args.includes('cwd') ? 'n/work/product\n' : `n/owner-account/thread-writer-locks/${threadId}.lock\n`;
    else throw Error(`unexpected ${binary}`);
    return {exitCode:0,stdout};
  };
  const runner=createSessionRunner({runtime:'cmux',command,parent:{sessionId:'reviewer',incarnationId:'review-v1',cwd:'/work/product',
    workerEnv:{CODEX_HOME:'/reviewer-account'},recipientEnv:{CODEX_HOME:'/owner-account'}},launch:()=>['codex'],pollAttempts:1});
  const recipient={sessionId:'recipient',incarnationId:'tty2:22:START',cwd:'/work/product',executable:'codex'};
  assert.equal((await runner.observe({recipient,nativeOwner:true})).worker.threadId,threadId);
});

test('native handoff observes exact suspended old owner twice and distinct current native caller',async t=>{
 for(const mode of ['stopped','running','resumed-race','old-thread','old-incarnation','wrong-caller','current-thread','active-child','malformed-inventory'])await t.test(mode,async()=>{
  const cwd='/work/product',old={runtime:'cmux',sessionId:'old',incarnationId:'tty1:11:START',cwd,worker:{executable:'claude',pid:11,incarnationId:'tty1:11:START',threadId:'old-thread'}};
  let states=0;
  const command=async(binary,args)=>{
   let stdout='';
   if(binary==='cmux')stdout=JSON.stringify(args.includes('identify')?{caller:{surface_id:mode==='wrong-caller'?'other':'new'}}:{windows:[{id:'window',workspaces:[{id:'work',panes:[{surfaces:[{id:'old',type:'terminal',tty:'tty1'},{id:'new',type:'terminal',tty:'tty2'}]}]}]}]});
   else if(binary==='ps')stdout=args.includes('pid=,ppid=,state=')?(mode==='malformed-inventory'?'invalid':`11 1 T\n12 11 ${mode==='active-child'?'S':'T'}\n22 1 S`):args.includes('state=')?(++states===2&&mode==='resumed-race'||mode==='running'?'S':'T'):args.includes('pid=,pgid=,tpgid=,comm=')?(args.includes('tty1')?'11 11 11 claude':'22 22 22 codex'):(args.includes('11')&&mode==='old-incarnation'?'CHANGED':'START');
   else if(binary==='lsof')stdout=`n${cwd}\n`;
   else if(binary==='pwd')stdout=cwd;
   else throw Error(`unexpected ${binary}`);
   return {exitCode:0,stdout};
  };
  const runner=createSessionRunner({runtime:'cmux',command,parent:{sessionId:'new',incarnationId:'tty2:22:START',cwd,workerExecutable:'codex'},launch:()=>['codex'],taskTransport:{identity:async observed=>({threadId:observed.pid===11?(mode==='old-thread'?'foreign':'old-thread'):(mode==='current-thread'?'foreign':'new-thread')})}});
  const observing=runner.observe({cwd,suspendedOwner:old});
  if(['stopped','current-thread'].includes(mode)){const observed=await observing;assert.equal(observed.previousOwnerSuspended,true);assert.equal(states,2);assert.equal(observed.worker.threadId,mode==='current-thread'?'foreign':'new-thread');}
  else await assert.rejects(observing,{code:'SESSION_OBSERVATION_INVALID'});
 });
});


test('suspended reviewer identity uses its immutable review account instead of the implementation account',async()=>{
 const cwd='/work/product',oldThread='11111111-1111-4111-8111-111111111111',newThread='22222222-2222-4222-8222-222222222222';
 const old={runtime:'cmux',sessionId:'old',incarnationId:'tty1:11:START',cwd,worker:{executable:'codex',pid:11,incarnationId:'tty1:11:START',threadId:oldThread}};
 const command=async(binary,args)=>{
  let stdout='';
  if(binary==='cmux')stdout=JSON.stringify(args.includes('identify')?{caller:{surface_id:'new'}}:{windows:[{id:'window',workspaces:[{id:'work',panes:[{surfaces:[{id:'old',type:'terminal',tty:'tty1'},{id:'new',type:'terminal',tty:'tty2'}]}]}]}]});
  else if(binary==='ps')stdout=args.includes('pid=,ppid=,state=')?'11 1 T\n22 1 S':args.includes('state=')?'T':args.includes('pid=,pgid=,tpgid=,comm=')?(args.includes('tty1')?'11 11 11 codex':'22 22 22 codex'):'START';
  else if(binary==='lsof')stdout=args.includes('cwd')?`n${cwd}\n`:args.includes('11')?`n/review-home/thread-writer-locks/${oldThread}.lock\n`:`n/new-home/thread-writer-locks/${newThread}.lock\n`;
  else if(binary==='pwd')stdout=cwd;
  else throw Error(`unexpected ${binary}`);
  return {exitCode:0,stdout};
 };
 const create=include=>createSessionRunner({runtime:'cmux',command,parent:{sessionId:'new',incarnationId:'tty2:22:START',cwd,workerExecutable:'codex',workerEnv:{CODEX_HOME:'/new-home'},recipientEnv:{CODEX_HOME:'/implementation-home'},suspendedReviewerEnvs:include?{[effectArgsDigest(old)]:{CODEX_HOME:'/review-home'}}:{}},launch:()=>['codex']});
 await assert.rejects(create(false).observe({cwd,suspendedOwner:old}));
 const observed=await create(true).observe({cwd,suspendedOwner:old});assert.equal(observed.previousOwnerSuspended,true);assert.equal(observed.worker.threadId,newThread);
});


test('exited owner observation proves complete PID and surface absence around the exact new native caller without a close effect',async t=>{
 for(const mode of ['absent','live-pid','live-surface','reused-surface','malformed','reappeared','wrong-caller'])await t.test(mode,async()=>{
  const cwd='/work/product',old={runtime:'cmux',sessionId:'old',incarnationId:'tty1:11:START',cwd,worker:{executable:'claude',pid:11,incarnationId:'tty1:11:START',threadId:'old-thread'}};let inventory=0;
  const command=async(binary,args)=>{
   let stdout='';
   if(binary==='cmux'){
    if(args.includes('identify'))stdout=JSON.stringify({caller:{surface_id:mode==='wrong-caller'?'foreign':'new'}});
    else if(args.includes('tree')){inventory++;stdout=JSON.stringify({windows:[{id:'window',workspaces:[{id:'work',panes:[{surfaces:[{id:'new',type:'terminal',tty:'tty2'},...(['live-surface','reused-surface'].includes(mode)||mode==='reappeared'&&inventory>2?[{id:'old',type:mode==='reused-surface'?'browser':'terminal',tty:'tty1'}]:[])]}]}]}]});}
    else throw Error('no terminal mutation is allowed');
   }else if(binary==='ps')stdout=args.includes('pid=')?(mode==='malformed'?'incomplete':mode==='live-pid'?'1\n11\n22':'1\n22'):args.includes('pid=,pgid=,tpgid=,comm=')?'22 22 22 codex':'START';
   else if(binary==='lsof')stdout=`n${cwd}\n`;
   else if(binary==='pwd')stdout=cwd;
   else throw Error(`unexpected ${binary}`);
   return {exitCode:0,stdout};
  };
  const runner=createSessionRunner({runtime:'cmux',command,parent:{sessionId:'new',incarnationId:'tty2:22:START',cwd,workerExecutable:'codex'},launch:()=>['codex'],taskTransport:{identity:async()=>({threadId:'new-thread'})}});
  if(mode==='absent'){const observed=await runner.observe({cwd,exitedOwner:old});assert.equal(observed.previousOwnerExited,true);assert.equal(observed.worker.threadId,'new-thread');}
  else await assert.rejects(runner.observe({cwd,exitedOwner:old}));
 });
});
