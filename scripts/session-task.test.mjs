import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTask, taskDigest, validateTaskReceipt } from './lib/session-task.mjs';
import { createCodexTaskTransport } from './lib/codex-task.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapters } from './lib/adapters.mjs';
import { submitCodexComposer } from './lib/codex-composer.mjs';
import { createSessionRunner } from './lib/session-runtime.mjs';

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
    if (binary === 'lsof') return { exitCode: 0, stdout: `n/x/thread-writer-locks/${child}.lock\nn/x/thread-writer-locks/${root}.lock\n` };
    assert.equal(JSON.parse(options.input).operation, 'identify');
    return { exitCode: 0, stdout: JSON.stringify({ threadId: chosen }) };
  } });
  assert.deepEqual(await transport.identity(observed), { threadId: root });
  chosen = 'unowned';
  await assert.rejects(transport.identity(observed), /not owned/);
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
    else if (binary === 'lsof') stdout = args.includes('-d') ? `p22\nn${root}\n` : `n/x/thread-writer-locks/${threadId}.lock\n`;
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

test('composer preserves pathname whitespace and refuses ambiguous display wrapping', async () => {
  for (const view of [screen('Read /work/two spaces/packet'), screen('Read /work/two  spaces/\n  packet')]) {
    let entered = false; let pasted = false;
    await assert.rejects(submitCodexComposer({ prompt: 'Read /work/two  spaces/packet', read: async () => view,
      verify: async () => {}, paste: async () => { pasted = true; }, enter: async () => { entered = true; },
    }), { code: 'SESSION_TASK_UNVERIFIED' });
    assert.equal(entered, false); assert.equal(pasted, false);
  }
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
    if (binary === 'lsof') return { exitCode: 0, stdout: `n/config/thread-writer-locks/${threadId}.lock\n` };
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
