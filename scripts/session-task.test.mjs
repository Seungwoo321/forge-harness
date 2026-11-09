import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTask, observeGoalTask, taskDigest, validateTaskReceipt } from './lib/session-task.mjs';
import { createCodexTaskTransport } from './lib/codex-task.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapters } from './lib/adapters.mjs';
import { codexComposerMatches, submitCodexComposer } from './lib/codex-composer.mjs';
import { createSessionRunner } from './lib/session-runtime.mjs';
import { createLedgerStore, executeEffect } from './lib/ledger.mjs';

const observed = { sessionId: 'terminal', incarnationId: 'incarnation', cwd: '/work/product', pid: 42 };
const packets = [{ path: '/work/packet', digest: taskDigest('packet\n'), content: 'packet\n' }];
const input = { effect: 'session.start', key: 'effect-key', args: { cwd: observed.cwd, handoffPath: packets[0].path, handoffDigest: packets[0].digest } };
const started = { state: 'started', promptDigest: taskDigest('prompt'), threadId: 'thread', requestId: 'request', turnId: 'turn', activityId: 'tool', packets };

test('pending input submits conditionally once; accepted input never submits twice', async () => {
  let state = 'prefilled'; let sends = 0;
  const transport = {
    async observe() { return state === 'started' ? started : { state, fence: 'composer-generation' }; },
    async submit({ fence }) { assert.equal(fence, 'composer-generation'); sends += 1; state = 'started'; },
  };
  for (let retry = 0; retry < 2; retry += 1) {
    assert.equal((await observeTask({ transport, observed, input, prompt: 'prompt', packets, submit: true })).task.activityId, 'tool');
  }
  assert.equal(sends, 1);
});

test('native goal submission is never repeated after an uncertain result', async () => {
  let state='absent', sends=0;
  const goalInput={...input,args:{...input.args,goalPath:packets[0].path,goalDigest:packets[0].digest}};
  const evidence={state:'started',threadId:'thread',turnId:'turn',activityId:'activity',packets,
    goal:{threadId:'thread',status:'active',objective:'finish'}};
  const transport={observeGoal:async()=>state==='started'?evidence:{state,threadId:'thread',fence:'thread',notApplied:true}};
  const fence=()=>({async mark(binding){this.attempted=true;this.binding=binding;}});
  const submission=fence(), options={transport,observed,input:goalInput,prompt:'finish',packets,submission,submit:async(_request,mark)=>{await mark();sends+=1;}};
  await assert.rejects(observeGoalTask(options),/has not started/);
  await assert.rejects(observeGoalTask(options),/has not started/);
  await assert.rejects(observeGoalTask({...options,submission:undefined}),/has not started/);
  assert.equal(sends,1);
  assert.throws(()=>validateTaskReceipt({...observed,task:{...observed,...started,schema:'harness.task-receipt/1',effectKey:goalInput.key}},goalInput),/receipt/);
  const preflight = fence();
  await assert.rejects(observeGoalTask({...options,submission:preflight,submit:async()=>{throw Error('not ready');}}),/not ready/);
  assert.equal(preflight.attempted,undefined);
  state='started';
  assert.equal((await observeGoalTask(options)).task.schema,'harness.goal-receipt/1');
  evidence.goal.objective='wrong';
  await assert.rejects(observeGoalTask(options),/receipt/);
});

test('native metadata selects the unique primary thread among child locks and rejects ambiguity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thread-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(!Object.hasOwn(r,'id'))return;
const id=r.params?.threadId;const source=['root','wrong-cwd'].includes(id)?'cli':id==='second'?'exec':{subAgent:{thread_spawn:{parent_thread_id:'root'}}};
const result=r.method==='initialize'?{}:{thread:{id,cwd:id==='wrong-cwd'?'/other':'/work/product',source}};
process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});
`, { mode: 0o755 });
  const command = createAdapters().command;
  const identify = ids => command(process.execPath, [path.resolve('scripts/codex-task-query.mjs')], { cwd: root,
    input: JSON.stringify({ operation: 'identify', executable, threadIds: ids, cwd: observed.cwd }) });
  const valid = await identify(['child', 'root', 'nested-child']);
  assert.equal(valid.exitCode, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).threadId, 'root');
  for (const ids of [['root', 'second'], ['child'], ['wrong-cwd']]) assert.notEqual((await identify(ids)).exitCode, 0);
});

test('multi-lock identity must belong to the observed process and remains fenced during submission', async () => {
  const root = '00000000-0000-0000-0000-000000000001';
  const child = '00000000-0000-0000-0000-000000000002';
  let chosen = root;
  const transport = createCodexTaskTransport({ command: async (binary, _args, options) => {
    if (binary === 'lsof') return { exitCode: 0, stdout: `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${child}.lock\nn${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${root}.lock\n` };
    assert.equal(JSON.parse(options.input).operation, 'identify');
    return { exitCode: 0, stdout: JSON.stringify({ threadId: chosen }) };
  } });
  assert.deepEqual(await transport.identity(observed), { threadId: root });
  chosen = 'unowned';
  await assert.rejects(transport.identity(observed), /not owned/);
});

test('native goal observation is bound to the same worker thread and directory', async () => {
  const threadId = '00000000-0000-0000-0000-000000000001';
  let cwd = observed.cwd;
  const transport = createCodexTaskTransport({ command: async (binary, _args, options) => {
    if (binary === 'lsof') return { exitCode: 0, stdout: `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n` };
    const request = JSON.parse(options.input);
    assert.equal(request.operation, 'goal');
    return { exitCode: 0, stdout: JSON.stringify({ thread: { id: threadId, cwd }, goal: { threadId, status: 'active', objective: 'complete work' } }) };
  } });
  assert.equal((await transport.goal(observed)).objective, 'complete work');
  cwd = '/other';
  await assert.rejects(transport.goal(observed), /thread changed/);
});

test('conditional delivery rejects a different ready native fence observed during the last identity check', async () => {
  const threadId = '00000000-0000-0000-0000-000000000001'; let sends = 0;
  const transport = createCodexTaskTransport({command:async()=>({exitCode:0,stdout:`n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n`}),
    submitInput:async(_request,verify)=>{await verify();sends++;}});
  transport.observe = async()=>({state:'ready',fence:'replacement-thread'});
  await assert.rejects(transport.submit({observed,input:{...input,effect:'session.deliver'},fence:threadId}),/fence changed/);
  assert.equal(sends,0);
});

test('goal activity must follow native goal creation and needs no ordinary user message', async () => {
  const threadId = '00000000-0000-0000-0000-000000000001';
  let startedAt = 10, itemStartedAt = 10999;
  const transport = createCodexTaskTransport({ command: async (binary, _args, options) => {
    if (binary === 'lsof') return { exitCode: 0, stdout: `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n` };
    assert.equal(JSON.parse(options.input).operation, 'goal-observe');
    return { exitCode: 0, stdout: JSON.stringify({ thread: { id: threadId, cwd: observed.cwd },
      goal: { threadId, status: 'active', objective: 'finish', createdAt: 10 },
      turns: [{ id: 'turn', startedAt, status: 'inProgress', items: [{ type: 'agentMessage', id: 'activity', startedAtMs:itemStartedAt }] }], queued: [] }) };
  } });
  const request = { observed, input, prompt: 'finish', packets: [] };
  assert.equal((await transport.observeGoal(request)).state, 'accepted');
  itemStartedAt = 11000;
  assert.equal((await transport.observeGoal(request)).activityId, 'activity');
  itemStartedAt = 10999; startedAt = 11;
  assert.equal((await transport.observeGoal(request)).activityId, 'activity');
  await assert.rejects(transport.observeGoal({ ...request, prompt: 'different' }), /differs/);
});

test('upgrading a legacy full-packet delivery observes its receipt or queue without submitting a new prompt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultPath = path.join(root, 'result.md'); const content = 'immutable result\n';
  await writeFile(resultPath, content);
  const digest = taskDigest(content);
  const prompt = `Receive the completed work result and continue its authorized next action.\n${resultPath}\n${digest}\n${content}`;
  const threadId = '00000000-0000-0000-0000-000000000001';
  let state = 'started'; let submissions = 0;
  const command = async (binary, args) => {
    let stdout;
    if (binary === 'cmux' && args.includes('tree')) stdout = JSON.stringify({ windows: [{ workspaces: [{ id: 'workspace', panes: [{ surfaces: [{ id: 'receiver', type: 'terminal', tty: 'tty2' }] }] }] }] });
    else if (binary === 'ps') stdout = args.includes('pid=,pgid=,tpgid=,comm=') ? '22 22 22 codex\n' : 'START';
    else if (binary === 'lsof') stdout = args.includes('-d') ? `p22\nn${root}\n` : `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n`;
    else if (binary === process.execPath) stdout = JSON.stringify({ thread: { id: threadId, cwd: root },
      queued: state === 'queued' ? [{ clientUserMessageId: 'key' }] : [], turns: state === 'queued' ? [] : [{ id: 'turn', status: 'completed', items: [
        { type: 'userMessage', id: 'request', content: [{ type: 'text', text: prompt }] },
        ...(state === 'started' ? [{ type: 'agentMessage', id: 'response' }] : []),
      ] }] });
    else { submissions += 1; throw Error('unexpected mutation'); }
    return { exitCode: 0, stdout };
  };
  const runner = createSessionRunner({ runtime: 'cmux', command, parent: { sessionId: 'owner', cwd: root, incarnationId: 'owner-generation' }, launch: () => ['codex'], pollAttempts: 1 });
  const request = { effect: 'session.deliver', key: 'key', args: { cwd: root, resultPath, resultDigest: digest,
    recipient: { sessionId: 'receiver', incarnationId: 'tty2:22:START', cwd: root, executable: 'codex' } } };
  assert.equal((await runner.execute(request)).task.promptDigest, taskDigest(prompt));
  for (state of ['accepted', 'queued']) assert.equal((await runner.verify(request)).status, 'unknown');
  assert.equal(submissions, 0);
});

const screen = (text, hint = 'tab to queue message') => `busy output\n› ${text}\n\n  Model · /work · Working · Context 30% left\n  ${hint}\n`;
test('busy composer settles before separate Return; a prefilled retry never pastes again', async () => {
  let text = 'Ask Codex to do anything'; const events = [];
  const options = { prompt: 'Read /packet (sha256:digest)',
    read: async () => screen(text), verify: async () => events.push('verify'),
    paste: async value => { events.push('paste'); text = value; }, enter: async () => events.push('Return') };
  await submitCodexComposer(options);
  assert.equal(events.filter(e => e === 'paste').length, 1);
  assert.equal(events.at(-1), 'Return');
  await submitCodexComposer(options);
  assert.equal(events.filter(e => e === 'paste').length, 1);
  assert.equal(events.filter(e => e === 'Return').length, 2);
});

test('composer refuses a foreign draft, modal and changed paste without Return', async () => {
  for (const mode of ['draft', 'modal', 'changed']) {
    let pasted = false; let entered = false;
    await assert.rejects(submitCodexComposer({ prompt: 'Read /packet', verify: async () => {},
      read: async () => mode === 'modal' ? 'Trust this directory?\n› 1. Yes' : screen(mode === 'draft' || pasted ? 'human draft' : 'Ask Codex to do anything'),
      paste: async () => { pasted = true; }, enter: async () => { entered = true; },
    }), { code: 'SESSION_TASK_UNVERIFIED' });
    assert.equal(entered, false);
    if (mode !== 'changed') assert.equal(pasted, false);
  }
});

test('composer preserves pathname whitespace and rejects different or clipped wrapped text', async () => {
  for (const view of [screen('Read /work/two spaces/packet'), screen('Read /work/two  spaces/\n  pack'), screen(' Read /work/two  spaces/packet'), screen('Read /work/two  spaces/\n   packet')]) {
    let entered = false; let pasted = false;
    await assert.rejects(submitCodexComposer({ prompt: 'Read /work/two  spaces/packet', read: async () => view,
      verify: async () => {}, paste: async () => { pasted = true; }, enter: async () => { entered = true; },
    }), { code: 'SESSION_TASK_UNVERIFIED' });
    assert.equal(entered, false); assert.equal(pasted, false);
  }
});

function narrowScreen(text, width = 42) {
  let column = 0; const lines = [''];
  for (const char of text) {
    const cells = /[가-힣]/u.test(char) ? 2 : 1;
    if (column + cells > width) { lines.push(''); column = 0; }
    lines[lines.length - 1] += char; column += cells;
  }
  return `› ${lines.join('\n  ')}\n\n  GPT model high · ~/work/product…\n  ← for agents · ? for shortcuts\n`;
}

test('narrow status-less composer matches the complete wrapped reference and settles before Return', async () => {
  const prompt = `Read /work/검증/two  spaces/${'packet'.repeat(16)} (sha256:${'a'.repeat(64)}); follow its referenced handoffs.`;
  assert.ok(codexComposerMatches(narrowScreen(prompt), prompt));
  let text = 'Ask Codex to do anything', pending, reads = 0, pastes = 0, enters = 0;
  const options = { prompt, verify: async () => {},
    read: async () => { if (pending && ++reads > 1) { text = pending; pending = undefined; } return narrowScreen(text); },
    paste: async value => { pending = value; pastes++; }, enter: async () => { enters++; } };
  await submitCodexComposer(options);
  assert.equal(pastes, 1); assert.equal(enters, 1);
  await submitCodexComposer(options);
  assert.equal(pastes, 1); assert.equal(enters, 2);
  for (const bad of [prompt.slice(1), prompt.slice(0, -1), prompt + ' foreign', prompt.replace('two  spaces', 'two spaces')]) {
    assert.equal(codexComposerMatches(narrowScreen(bad), prompt), false);
  }
});

test('narrow composer rechecks draft and native identity after verification at paste and Return', async () => {
  for (const boundary of ['paste', 'Return']) for (const change of ['draft', 'identity']) {
    const prompt = 'Read /work/result (sha256:exact)'; let text = boundary === 'paste' ? 'Ask Codex to do anything' : prompt;
    let pastes = 0, enters = 0;
    await assert.rejects(submitCodexComposer({ prompt, read: async () => narrowScreen(text),
      verify: async () => { if (change === 'identity') throw Error('native worker changed'); text = 'foreign draft'; },
      paste: async () => { pastes++; }, enter: async () => { enters++; } }));
    assert.equal(pastes, 0); assert.equal(enters, 0);
  }
});

test('footer-like and prompt-like foreign continuation text cannot hide a draft prefix or suffix', async () => {
  const prompt = 'Read /work/result (sha256:exact)';
  for (const text of [prompt+'\n\n? for shortcuts\nforeign tail', prompt+'\nmodel · Ready · context\nforeign tail', 'foreign prefix\n› '+prompt]) {
    const view = narrowScreen('Ask Codex to do anything').replace('Ask Codex to do anything', text.replaceAll('\n','\n  '));
    let enters = 0, pastes = 0;
    assert.equal(codexComposerMatches(view,prompt),false);
    await assert.rejects(submitCodexComposer({prompt,read:async()=>view,verify:async()=>{},paste:async()=>{pastes++;},enter:async()=>{enters++;}}));
    assert.equal(enters,0); assert.equal(pastes,0);
  }
});

test('native delivery accepts a wrapped reference in the same narrow receiver and requires its real packet read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narrow-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultPath = path.join(root, 'result.md'), content = 'immutable result\n', digest = taskDigest(content);
  await writeFile(resultPath, content);
  const prompt = `Read ${resultPath} (${digest}); follow its referenced handoffs.`;
  const threadId = '00000000-0000-0000-0000-000000000001';
  let draft = prompt, delivered = false, readPacket = false, pastes = 0, enters = 0;
  const command = async (binary, args, options) => {
    let stdout;
    if (binary === 'cmux' && args.includes('tree')) stdout = JSON.stringify({ windows: [{ workspaces: [{ id: 'workspace', panes: [{ surfaces: [{ id: 'receiver', type: 'terminal', tty: 'tty2' }] }] }] }] });
    else if (binary === 'ps') stdout = args.includes('pid=,pgid=,tpgid=,comm=') ? '22 22 22 codex\n' : 'START';
    else if (binary === 'lsof') stdout = args.includes('-d') ? `p22\nn${root}\n` : `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n`;
    else if (binary === 'cmux' && args.includes('terminal.viewport')) stdout = JSON.stringify({surface_id:'receiver',columns:44});
    else if (binary === 'cmux' && args.includes('read-screen')) stdout = narrowScreen(draft);
    else if (binary === 'cmux' && args.includes('surface.send_text')) { pastes++; draft = JSON.parse(args.at(-1)).text; stdout = '{}'; }
    else if (binary === 'cmux' && args.includes('send-key')) { assert.equal(args.at(-1), 'Return'); enters++; delivered = true; stdout = 'OK'; }
    else if (binary === process.execPath) stdout = JSON.stringify({ thread:{id:threadId,cwd:root}, queued:[],
      turns: delivered ? [{id:'turn',status:'completed',items:[{type:'userMessage',id:'request',content:[{type:'text',text:prompt}]},
        {type:'agentMessage',id:'response'}, ...(readPacket ? [{type:'commandExecution',id:'read',status:'completed',exitCode:0,cwd:root,commandActions:[{type:'read',path:resultPath}],aggregatedOutput:content}] : [])]}] : [] });
    else throw Error(`unexpected command ${binary} ${args}`);
    return {exitCode:0,stdout};
  };
  const runner = createSessionRunner({runtime:'cmux',command,parent:{sessionId:'owner',cwd:root,incarnationId:'owner-generation'},launch:()=>['codex'],pollAttempts:1});
  const request = {effect:'session.deliver',key:'same-delivery',args:{cwd:root,session:'receiver',incarnation:'tty2:22:START',resultPath,resultDigest:digest,recipient:{sessionId:'receiver',incarnationId:'tty2:22:START',cwd:root,executable:'codex'}}};
  assert.equal((await runner.verify(request)).status, 'not-applied');
  const store = createLedgerStore(path.join(root,'state'));
  const run = () => executeEffect({unit:'delivery',effect:request.effect,args:request.args,policy:{goal:{class:'task'},authority:{allow:[],deny:[]},delivery:'none'},
    context:{explicitUserInstruction:true,productOwned:true},store,adapter:{...runner,now:()=> 'time'}});
  assert.equal((await run()).status,'uncertain');
  assert.equal(enters, 1); assert.equal(pastes, 0);
  assert.equal((await runner.verify(request)).status, 'unknown');
  readPacket = true;
  assert.equal((await run()).status,'reconciled');
  assert.equal(validateTaskReceipt((await runner.verify(request)).result, request).task.promptDigest, taskDigest(prompt));
  assert.equal((await runner.execute(request)).task.effectKey, request.key);
  assert.equal(enters, 1); assert.equal(pastes, 0);
});

for (const state of ['modal', 'startup', 'queued', 'accepted', 'unknown']) {
  test(`${state} does not authorize Enter or prove task start`, async () => {
    let sends = 0;
    await assert.rejects(observeTask({ transport: { observe: async () => ({ state }), submit: async () => { sends += 1; } }, observed, input, prompt: 'prompt', packets, submit: true }), { code: 'SESSION_TASK_UNVERIFIED' });
    assert.equal(sends, 0);
  });
}

test('receipt mismatches fail closed for effect, incarnation, packet, cwd, and activity', async () => {
  const result = await observeTask({ transport: { observe: async () => started }, observed, input, prompt: 'prompt', packets });
  for (const patch of [{ effectKey: 'old-effect' }, { incarnationId: 'old-process' }, { packets: [] }, { cwd: '/other' }, { activityId: 'request' }]) {
    assert.throws(() => validateTaskReceipt({ ...result, task: { ...result.task, ...patch } }, input), { code: 'SESSION_TASK_UNVERIFIED' });
  }
});

test('native Codex evidence binds writer lock, exact prompt and actual packet read; queued input is not execution', async () => {
  const threadId = '00000000-0000-0000-0000-000000000001';
  let turnStatus = 'interrupted';
  let mode = 'started';
  const command = async (binary, _args, options) => {
    if (binary === 'lsof') return { exitCode: 0, stdout: `n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n` };
    const request = JSON.parse(options.input);
    assert.equal(request.threadId, threadId);
    return { exitCode: 0, stdout: JSON.stringify({ thread: { id: threadId, cwd: observed.cwd },
      queued: mode === 'queued' ? [{ clientUserMessageId: input.key, input: [{ type: 'text', text: 'prompt' }] }] : [],
      turns: mode === 'queued' ? [] : [{ id: 'turn', status: turnStatus, items: [
        { type: 'userMessage', id: 'request', content: [{ type: 'text', text: mode === 'wrong-prompt' ? 'other' : 'prompt' }] },
        { type: 'commandExecution', id: 'tool', status: 'completed', exitCode: 0, cwd: '/work',
          commandActions: mode.startsWith('checksum') ? [{ type: 'unknown' }] : [{ type: 'read', path: packets[0].path }],
          aggregatedOutput: mode === 'wrong-packet' ? 'old packet' : packets[0].content
            + (mode === 'appended' ? 'CHANGED NEXT ACTION\n' : '')
            + (mode === 'wrong-checksum-read' ? `${'0'.repeat(64)}  packet\n` : '')
            + (mode.startsWith('checksum') ? `${packets[0].digest.slice(7)}  ${mode === 'checksum-wrong-file' ? 'another' : 'packet'}\n` : '') },
      ] }],
    }) };
  };
  const transport = createCodexTaskTransport({ command });
  const request = { transport, observed, input, prompt: 'prompt', packets };
  assert.equal((await observeTask(request)).task.turnStatus, 'interrupted');
  turnStatus = 'completed';
  assert.equal((await observeTask(request)).task.threadId, threadId);
  mode = 'checksum';
  assert.equal((await observeTask(request)).task.packets[0].digest, packets[0].digest);
  for (const value of ['queued', 'wrong-prompt', 'wrong-packet', 'checksum-wrong-file', 'appended', 'wrong-checksum-read']) {
    mode = value;
    await assert.rejects(observeTask(request), { code: 'SESSION_TASK_UNVERIFIED' });
  }
});

test('native worker lock must belong to the selected account', async () => {
  const transport=createCodexTaskTransport({env:{CODEX_HOME:'/selected-account'},command:async()=>({exitCode:0,
    stdout:'n/another-account/thread-writer-locks/00000000-0000-0000-0000-000000000001.lock\n'})});
  await assert.rejects(transport.identity(observed),/ownership is missing/);
});

test('completed native goals retain post-goal reads verified by a later checksum command',async()=>{
 const threadId='00000000-0000-0000-0000-000000000001';
 let checksumStatus='completed';
 const transport=createCodexTaskTransport({command:async(binary)=>binary==='lsof'
  ? {exitCode:0,stdout:`n${process.env.CODEX_HOME ?? process.env.HOME+'/.codex'}/thread-writer-locks/${threadId}.lock\n`}
  : {exitCode:0,stdout:JSON.stringify({thread:{id:threadId,cwd:observed.cwd},queued:[],
    goal:{threadId,status:'complete',objective:'finish',createdAt:10},turns:[{id:'turn',status:'completed',startedAt:11,items:[
     {type:'commandExecution',id:'read',cwd:'/work',status:'completed',exitCode:0,commandActions:[{type:'read',path:packets[0].path}],aggregatedOutput:packets[0].content+'\nother output'},
     {type:'commandExecution',id:'hash',cwd:'/work',status:checksumStatus,exitCode:0,aggregatedOutput:`${packets[0].digest.slice(7)}  ${packets[0].path}\n`},
    ]}]})}});
 const request={observed,input,prompt:'finish',packets};
 assert.equal((await transport.observeGoal(request)).state,'started');
 checksumStatus='failed';
 assert.equal((await transport.observeGoal(request)).state,'accepted');
});

test('managed custody cannot accept a receipt without verified hook enforcement',()=>{
 const goalInput={...input,args:{...input.args,goalDigest:taskDigest('snapshot')}};
 const identity={sessionId:observed.sessionId,incarnationId:observed.incarnationId,cwd:observed.cwd};
 const result={...identity,task:{...identity,schema:'harness.goal-receipt/1',effectKey:input.key,promptDigest:taskDigest('finish'),goalDigest:goalInput.args.goalDigest,
  goal:{threadId:'thread',status:'active',objective:'finish'},threadId:'thread',turnId:'turn',activityId:'activity',packets:[]}};
 const bareInput={...goalInput,args:{cwd:observed.cwd,goalDigest:goalInput.args.goalDigest}};
 assert.throws(()=>validateTaskReceipt(result,bareInput,{requireEnforcement:true}),/hook enforcement is unverified/);
 result.task.enforcement={status:'verified',cwd:observed.cwd,key:'guard',hash:'hash'};
 assert.equal(validateTaskReceipt(result,bareInput,{requireEnforcement:true}),result);
});

test('native thread drift after submission cannot satisfy the original durable binding',async()=>{
 let submitted=false;const goalInput={...input,args:{...input.args,goalPath:packets[0].path,goalDigest:packets[0].digest}};
 const submission={recovery:true,async mark(binding){this.attempted=true;this.binding=binding;}};
 const transport={observeGoal:async()=>submitted?{state:'started',threadId:'replacement',turnId:'turn',activityId:'activity',packets,
  goal:{threadId:'replacement',status:'active',objective:'finish'}}:{state:'absent',threadId:'original',fence:'original',notApplied:true}};
 await assert.rejects(observeGoalTask({transport,observed,input:goalInput,prompt:'finish',packets,submission,
  submit:async(_request,mark)=>{await mark();submitted=true;}}),/owner or packets changed/);
});

test('only a fresh launch may use missing Claude startup history; positive pending evidence never permits input',async()=>{
 const goalInput={...input,args:{...input.args,goalPath:packets[0].path,goalDigest:packets[0].digest}};
 for(const recovery of [false,true])for(const state of ['unknown','accepted','absent']) {
  let submits=0;
  const submission={recovery,async mark(binding){this.attempted=true;this.binding=binding;}};
  const transport={observeGoal:async()=>({state,threadId:'thread',fence:'thread',notApplied:false,freshOnly:true})};
  await assert.rejects(observeGoalTask({transport,observed,input:goalInput,prompt:'finish',packets,submission,
   submit:async(_request,mark)=>{await mark();submits++;}}));
  assert.equal(submits,state==='absent'&&!recovery?1:0);
 }
});
