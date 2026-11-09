import test from 'node:test';
import assert from 'node:assert/strict';
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
