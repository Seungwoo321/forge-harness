import { effectArgsDigest } from './approvals.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const taskDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const packetReadContract = 'Within the existing goal, read each such packet unfiltered: either a bare `cat <path>` that the runtime recognizes as a file read and whose complete output equals the file, '
  + 'or one successful command whose complete output contains the whole file followed by its `shasum -a 256 <absolute path>` line. '
  + 'Summarized, truncated or compacted output, a hash from another unrecognized command and a digest alone are not read proof; run an output compactor or wrapper in its raw mode.';
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

// A worker's hooks count as enforced only when the hooks trusted before launch are the hooks observed now.
// A current account/cwd observation alone does not show what an already-running worker loaded.
function assertLaunchEnforcement(observed, bound, cwd) {
  const unverified = reason => { throw taskError(`managed session hook enforcement is unverified: ${reason}`); };
  if (observed?.status !== 'verified' || observed.cwd !== cwd || !observed.key || !observed.hash || !Array.isArray(observed.hooks))
    unverified(observed?.reason ?? 'required hooks are not currently trusted');
  if (!bound) unverified('the start has no pre-launch trusted hook observation');
  if (bound.cwd !== cwd || !Array.isArray(bound.hooks) || !bound.hooks.length) unverified('the pre-launch hook observation is incomplete');
  for (const hook of bound.hooks) {
    const current = observed.hooks.find(item => item.eventName === hook.eventName);
    if (current?.key !== hook.key || current.hash !== hook.hash)
      unverified(`${hook.eventName} hook changed after launch (${hook.hash} -> ${current?.hash ?? 'missing'})`);
  }
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
    // Verification may pass the intent without its effect name; a delivery is identified by its recipient and result.
    || !((input.effect === 'session.deliver' || input.args.recipient) && input.args.resultPath ? ['result'] : ['handoff', 'result', 'goal']).every(name => input.args[`${name}Path`] === undefined || receipt.packets.some(ref =>
      ref.path === input.args[`${name}Path`] && ref.digest === input.args[`${name}Digest`]))) {
    throw taskError('native request/start receipt does not match the intended task');
  }
  if (requireEnforcement) assertLaunchEnforcement(receipt.enforcement, input.args.enforcement, result.cwd);
  return result;
}

export async function observeGoalTask({ transport, observed, input, prompt, packets, submission, submit }) {
  if (!transport || typeof transport.observeGoal !== 'function' || typeof prompt !== 'string' || !prompt.trim()) throw taskError('native goal transport is required');
  const request = {observed,input,prompt,packets};
  let evidence = await transport.observeGoal(request);
  const threadId = evidence.threadId ?? evidence.fence;
  const binding = {runtime:observed.runtime,sessionId:observed.sessionId,incarnationId:observed.incarnationId,cwd:observed.cwd,
    executable:observed.executable,pid:observed.pid,threadId,promptDigest:taskDigest(prompt),goalDigest:input.args.goalDigest,
    packets:packets.map(({path,digest})=>({path,digest}))};
  if (submission?.attempted && effectArgsDigest(submission.binding) !== effectArgsDigest(binding)) throw taskError('native submission owner or packets changed');
  const resumeDraft = submission?.attempted && submission.pendingDraft && !submission.confirmed && !submission.readOnly && evidence.state === 'unmaterialized';
  if (['absent','unmaterialized'].includes(evidence.state) && submission && (!submission.attempted || resumeDraft)) {
    if (submission.readOnly) throw taskError('completed native start is observation-only');
    const preTurn = evidence.state === 'unmaterialized';
    if (!threadId || (preTurn ? !/^codex\/(?:0\.167\.[01]|0\.168\.0|0\.169\.[01])$/.test(evidence.proof?.platform ?? '') || evidence.proof.threadId !== threadId
      || !evidence.proof.sqliteRoot || evidence.proof.queueCount !== 0
      : evidence.notApplied !== true && (submission.recovery || evidence.freshOnly !== true))) throw taskError('native input absence is unverified');
    if (typeof submission.mark !== 'function') throw taskError('durable native submission fence is unavailable');
    if (typeof submit !== 'function') throw taskError('native goal submission is unavailable');
    await submit({...request,threadId,binding,resumeDraft,...(preTurn ? {preTurn:evidence.proof} : {})}, async () => { await submission.mark(binding); });
    if (!submission.attempted) throw taskError('native goal submission did not record its mutation boundary');
    evidence = await transport.observeGoal(request);
    if ((evidence.threadId ?? evidence.fence) !== submission.binding.threadId) throw taskError('native submission owner or packets changed');
  }
  if (evidence.state === 'accepted' && evidence.goal && evidence.missingPackets?.length) {
    // The goal is already running: report the incomplete packet proof and never resubmit it.
    throw Object.assign(taskError(`native goal accepted; immutable packet read proof is incomplete for ${evidence.missingPackets.map(packet => packet.path).join(', ')}. ${packetReadContract}`),
      {taskState:evidence.state, missingPackets:evidence.missingPackets});
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
