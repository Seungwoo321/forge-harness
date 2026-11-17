import test from 'node:test';
import assert from 'node:assert/strict';
import {effectArgsDigest} from './lib/approvals.mjs';
import { createSessionRunner } from './lib/session-runtime.mjs';

function fixture(mode) {
  let present = true;
  let closes = 0;
  let placeholder = false;
  let unrelated = false;
  let workspaceClosed = 0;
  const solo = mode === 'solo-race' || mode === 'solo-handoff' || mode === 'solo-user';
  const title = mode === 'solo-handoff' || mode === 'solo-race' ? `handoff-${'a'.repeat(64)}` : mode === 'solo-user' ? 'my workspace' : undefined;
  const owner = { sessionId: 'owner', cwd: '/work/product', incarnationId: 'tty1:11:START', tty: 'tty1',
    worker: { executable: 'worker', incarnationId: 'tty1:11:START', pid: 11, threadId: 'native-owner' } };
  const recipient = { sessionId: 'receiver', cwd: '/work/product', incarnationId: 'tty2:22:START', executable: 'worker' };
  const input = { effect: 'session.close', key: 'close-key', args: { owner, recipient, session: 'owner', incarnation: owner.incarnationId } };
  const command = async (binary, args) => {
    let stdout = '';
    if (binary === 'cmux' && args.includes('tree')) stdout = JSON.stringify({ windows: [{ id: 'window', workspaces: [{ id: 'workspace', title, panes: [{ surfaces: [
      ...(present ? [{ id: 'owner', type: 'terminal', tty: 'tty1' }] : []), ...(placeholder ? [{id:'placeholder',type:'terminal',tty:'tty3'}] : []),
      ...(solo?[]:[{ id: 'receiver', type: 'terminal', tty: 'tty2' }]),
      ...(unrelated?[{id:'user-shell',type:'terminal',tty:'tty4'}]:[]),
    ] }] }, ...(solo?[{id:'receiver-workspace',panes:[{surfaces:[{id:'receiver',type:'terminal',tty:'tty2'}]}]}]:[])] }] });
    else if (binary === 'cmux' && args.includes('new-surface')) { placeholder = true; stdout = JSON.stringify({ surface_id: 'placeholder', workspace_id: 'workspace' }); }
    else if (binary === 'cmux' && args.includes('close-workspace')) { workspaceClosed += 1; }
    else if (binary === 'cmux' && args.includes('close-surface')) {
      if(mode==='solo-race') unrelated = true;
      assert.equal(args[args.indexOf('--workspace') + 1], 'workspace');
      closes += 1; if (mode === 'failed') return { exitCode: 1 }; present = false; if (mode === 'lost') return { exitCode: 1 };
    }
    else if (binary === 'ps') {
      if (args.includes('tty=')) stdout = mode === 'caller' ? 'tty1' : '??';
      else if (args.includes('pid=,pgid=,tpgid=,comm=')) stdout = args.includes('tty2') ? '22 22 22 worker\n' : '11 11 11 worker\n';
      else stdout = mode === 'reused' && args.includes('11') ? 'CHANGED' : mode === 'recipient-drift' && args.includes('22') ? 'CHANGED' : 'START';
    } else if (binary === 'lsof') stdout = 'p11\nn/work/product\n';
    else throw new Error(`unexpected ${binary} ${args.join(' ')}`);
    return { exitCode: 0, stdout };
  };
  const runner = createSessionRunner({ runtime: 'cmux', command, parent: { ...owner, closable: mode !== 'orchestrator' },
    launch: () => ['worker'], pollAttempts: 1, taskTransport: { async identity() { return { threadId: mode === 'thread-drift' ? 'another-thread' : 'native-owner' }; } } });
  return { runner, input, closes: () => closes, placeholder: () => placeholder, unrelated: () => unrelated, workspaceClosed: () => workspaceClosed };
}

for (const mode of ['orchestrator', 'caller', 'reused', 'recipient-drift', 'thread-drift']) {
  test(`native close rejects ${mode} before touching a surface`, async () => {
    const f = fixture(mode);
    await assert.rejects(f.runner.execute(f.input));
    assert.equal(f.closes(), 0);
  });
}

test('native close verifies disappearance and lost response reconciles without another close', async () => {
  for (const mode of ['success', 'lost']) {
    const f = fixture(mode);
    if (mode === 'lost') await assert.rejects(f.runner.execute(f.input));
    else assert.equal((await f.runner.execute(f.input)).closed, true);
    const checked = await f.runner.verify(f.input);
    assert.equal(checked.status, 'completed');
    assert.equal(checked.result.incarnationId, f.input.args.owner.incarnationId);
    assert.equal(f.closes(), 1);
  }
});

test('native failed close remains unknown while the exact session still exists', async () => {
  const f = fixture('failed');
  await assert.rejects(f.runner.execute(f.input));
  assert.equal((await f.runner.verify(f.input)).status, 'not-applied');
  assert.equal(f.closes(), 1);
});


test('last-surface closure uses an exited placeholder and never closes concurrently added surfaces', async () => {
  const f = fixture('solo-race');
  assert.equal((await f.runner.execute(f.input)).closed, true);
  assert.equal(f.placeholder(), true);
  assert.equal(f.unrelated(), true);
  assert.equal(f.closes(), 1);
});

test('a harness-created workspace left with only its placeholder is closed; other workspaces are kept', async () => {
  const handoff = fixture('solo-handoff');
  assert.equal((await handoff.runner.execute(handoff.input)).closed, true);
  assert.equal(handoff.workspaceClosed(), 1);
  const user = fixture('solo-user');
  assert.equal((await user.runner.execute(user.input)).closed, true);
  assert.equal(user.workspaceClosed(), 0);
  const race = fixture('solo-race');
  assert.equal((await race.runner.execute(race.input)).closed, true);
  assert.equal(race.workspaceClosed(), 0);
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
