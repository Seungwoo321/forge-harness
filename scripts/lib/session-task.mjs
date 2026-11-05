import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const taskDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const taskError = message => Object.assign(new Error(message), { code: 'SESSION_TASK_UNVERIFIED' });

export async function taskPackets(args) {
  const packets = [];
  for (const name of ['handoff', 'result', 'goal']) {
    if (args[`${name}Path`] === undefined) continue;
    const ref = { path: args[`${name}Path`], digest: args[`${name}Digest`] };
    const content = await readFile(ref.path, 'utf8');
    if (taskDigest(content) !== ref.digest) throw taskError(`${name} packet changed`);
    packets.push({ ...ref, content });
  }
  if (!packets.length) throw taskError('task requires an immutable packet');
  return packets;
}

export function validateTaskReceipt(result, input, {requireEnforcement = false} = {}) {
  const receipt = result?.task;
  const goalReceipt = receipt?.schema === 'harness.goal-receipt/1';
  if (!result?.sessionId || !result.incarnationId || result.cwd !== input.args.cwd
    || (!goalReceipt && receipt?.schema !== 'harness.task-receipt/1') || receipt.effectKey !== input.key
    || (input.effect === 'session.start' && input.args.goalPath && !goalReceipt)
    || receipt.sessionId !== result.sessionId || receipt.incarnationId !== result.incarnationId || receipt.cwd !== result.cwd
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.promptDigest ?? '')
    || !(goalReceipt ? ['threadId', 'turnId', 'activityId'] : ['threadId', 'requestId', 'turnId', 'activityId']).every(name => typeof receipt[name] === 'string' && receipt[name])
    || (goalReceipt ? !/^sha256:[a-f0-9]{64}$/.test(input.args.goalDigest ?? '') || receipt.goalDigest !== input.args.goalDigest || receipt.goal?.threadId !== receipt.threadId || !['active','complete'].includes(receipt.goal?.status) || taskDigest(receipt.goal.objective ?? '') !== receipt.promptDigest : receipt.requestId === receipt.activityId)
    || !Array.isArray(receipt.packets)
    // A delivery to the goal owner is received through its result packet; starts bind every packet.
    || !(input.effect === 'session.deliver' && input.args.resultPath ? ['result'] : ['handoff', 'result', 'goal']).every(name => input.args[`${name}Path`] === undefined || receipt.packets.some(ref =>
      ref.path === input.args[`${name}Path`] && ref.digest === input.args[`${name}Digest`]))) {
    throw taskError('native request/start receipt does not match the intended task');
  }
  if (requireEnforcement && (receipt.enforcement?.status !== 'verified' || receipt.enforcement.cwd !== result.cwd
    || !receipt.enforcement.key || !receipt.enforcement.hash)) throw taskError('managed session hook enforcement is unverified');
  return result;
}

export async function observeGoalTask({ transport, observed, input, prompt, packets, submission, submit }) {
  if (!transport || typeof transport.observeGoal !== 'function' || typeof prompt !== 'string' || !prompt.trim()) throw taskError('native goal transport is required');
  const request = {observed,input,prompt,packets};
  let evidence = await transport.observeGoal(request);
  if (evidence.state === 'absent' && submission && !submission.attempted) {
    if (typeof submit !== 'function') throw taskError('native goal submission is unavailable');
    await submit(request, () => { submission.attempted = true; });
    if (!submission.attempted) throw taskError('native goal submission did not record its mutation boundary');
    evidence = await transport.observeGoal(request);
  }
  if (evidence.state !== 'started') throw Object.assign(taskError('native goal or packet delivery has not started'), {taskState:evidence.state});
  return validateTaskReceipt({...observed,task:{...evidence,schema:'harness.goal-receipt/1',effectKey:input.key,
    sessionId:observed.sessionId,incarnationId:observed.incarnationId,cwd:observed.cwd,
    promptDigest:taskDigest(prompt),goalDigest:input.args.goalDigest}},input);
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
