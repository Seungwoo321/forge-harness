import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTask, taskDigest, validateTaskReceipt } from './lib/session-task.mjs';
import { createCodexTaskTransport } from './lib/codex-task.mjs';

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
        { type: 'commandExecution', id: 'tool', status: 'completed', exitCode: 0, commandActions: [{ type: 'read', path: packets[0].path }], aggregatedOutput: mode === 'wrong-packet' ? 'old packet' : packets[0].content },
      ] }],
    }) };
  };
  const transport = createCodexTaskTransport({ command });
  const request = { transport, observed, input, prompt: 'prompt', packets };
  assert.equal((await observeTask(request)).task.turnStatus, 'interrupted');
  turnStatus = 'completed';
  assert.equal((await observeTask(request)).task.threadId, threadId);
  for (const value of ['queued', 'wrong-prompt', 'wrong-packet']) {
    mode = value;
    await assert.rejects(observeTask(request), { code: 'SESSION_TASK_UNVERIFIED' });
  }
});
