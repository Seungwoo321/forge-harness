import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const taskDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const taskError = message => Object.assign(new Error(message), { code: 'SESSION_TASK_UNVERIFIED' });

export async function taskPackets(args) {
  const packets = [];
  for (const name of ['handoff', 'result']) {
    if (args[`${name}Path`] === undefined) continue;
    const ref = { path: args[`${name}Path`], digest: args[`${name}Digest`] };
    const content = await readFile(ref.path, 'utf8');
    if (taskDigest(content) !== ref.digest) throw taskError(`${name} packet changed`);
    packets.push({ ...ref, content });
  }
  if (!packets.length) throw taskError('task requires an immutable packet');
  return packets;
}

export function validateTaskReceipt(result, input) {
  const receipt = result?.task;
  if (!result?.sessionId || !result.incarnationId || result.cwd !== input.args.cwd
    || receipt?.schema !== 'harness.task-receipt/1' || receipt.effectKey !== input.key
    || receipt.sessionId !== result.sessionId || receipt.incarnationId !== result.incarnationId || receipt.cwd !== result.cwd
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.promptDigest ?? '')
    || !['threadId', 'requestId', 'turnId', 'activityId'].every(name => typeof receipt[name] === 'string' && receipt[name])
    || receipt.requestId === receipt.activityId
    || !Array.isArray(receipt.packets)
    || !['handoff', 'result'].every(name => input.args[`${name}Path`] === undefined || receipt.packets.some(ref =>
      ref.path === input.args[`${name}Path`] && ref.digest === input.args[`${name}Digest`]))) {
    throw taskError('native request/start receipt does not match the intended task');
  }
  return result;
}

export async function observeTask({ transport, observed, input, prompt, packets, submit = false }) {
  if (!transport || typeof transport.observe !== 'function' || typeof prompt !== 'string' || !prompt.trim()) throw taskError('worker task transport is required');
  const request = { observed, input, prompt, packets };
  let evidence = await transport.observe(request);
  if (submit && ['ready', 'prefilled'].includes(evidence?.state)) {
    if (typeof transport.submit !== 'function' || !evidence.fence) throw taskError('conditional submission is unavailable');
    await transport.submit({ ...request, fence: evidence.fence });
    evidence = await transport.observe(request);
  }
  if (evidence?.state !== 'started' || evidence.promptDigest !== taskDigest(prompt)) {
    throw Object.assign(taskError('request has not started'), { taskState: evidence?.state, notApplied: evidence?.state === 'ready' && evidence.notApplied === true && Boolean(evidence.fence) });
  }
  return validateTaskReceipt({ ...observed, task: {
    ...evidence, schema: 'harness.task-receipt/1', effectKey: input.key,
    sessionId: observed.sessionId, incarnationId: observed.incarnationId, cwd: observed.cwd,
  } }, input);
}
