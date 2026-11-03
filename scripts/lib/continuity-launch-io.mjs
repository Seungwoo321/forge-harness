import { taskPackets } from './session-task.mjs';
import { selectExecutionPolicy } from './continuity-decision.mjs';
import { buildManagedLaunch } from './continuity-launch.mjs';
import { prepareEffect } from './policy.mjs';

export async function loadManagedLaunch(args, runtime) {
  const packets = await taskPackets(args);
  let snapshot;
  try { snapshot = JSON.parse(packets.find(packet => packet.path === args.goalPath)?.content ?? 'null'); }
  catch { throw Object.assign(new Error('goal snapshot is invalid'), {code:'CONTINUITY_INVALID'}); }
  if (!snapshot || (runtime && selectExecutionPolicy(snapshot.policy,args.role).runtime !== runtime)) throw Object.assign(new Error('goal runtime differs from configured runner'), {code:'CONTINUITY_INVALID'});
  return buildManagedLaunch({goal:snapshot.goal,policy:snapshot.policy,
    handoff:{path:args.handoffPath,digest:args.handoffDigest},goalRef:{path:args.goalPath,digest:args.goalDigest},
    effectKey:prepareEffect('session.start',args).key,packets,role:args.role,unit:args.unit});
}
