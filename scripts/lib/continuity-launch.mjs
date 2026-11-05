import path from 'node:path';
import { createHash } from 'node:crypto';
import { composeGoalPrompt, selectExecutionPolicy } from './continuity-decision.mjs';

export function buildManagedLaunch({ goal, policy, handoff, goalRef, effectKey, packets = [], role = 'implementation', unit, cwd }) {
  policy = selectExecutionPolicy(policy, role);
  if (!path.isAbsolute(policy.account)) throw Object.assign(new TypeError('account configuration path must be absolute'), { code: 'CONTINUITY_INVALID' });
  const env = policy.provider === 'codex' ? { CODEX_HOME: policy.account } : { CLAUDE_CONFIG_DIR: policy.account };
  if (policy.provider === 'claude' && !/^sha256:[a-f0-9]{64}$/.test(effectKey ?? '')) throw Object.assign(new TypeError('Claude launch requires an effect key'), {code:'CONTINUITY_INVALID'});
  const hash = effectKey ? createHash('sha256').update(`${effectKey}:${goalRef?.digest ?? ''}`).digest('hex') : null;
  const sessionId = hash ? `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}` : null;
  const options = policy.provider === 'codex'
    ? ['--model', policy.model, '-c', `model_reasoning_effort=${JSON.stringify(policy.effort)}`]
    : ['--model', policy.model, '--effort', policy.effort, '--session-id', sessionId];
  if (!goalRef || !path.isAbsolute(goalRef.path) || !/^sha256:[a-f0-9]{64}$/.test(goalRef.digest ?? '')) throw Object.assign(new TypeError('immutable goal reference is required'), { code: 'CONTINUITY_INVALID' });
  if (unit) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '..' || path.basename(path.dirname(goalRef.path)) !== 'snapshots' || path.basename(path.dirname(path.dirname(goalRef.path))) !== goal.id || path.basename(path.dirname(path.dirname(path.dirname(goalRef.path)))) !== 'goals') throw Object.assign(new TypeError('goal snapshot location or unit is invalid'), {code:'CONTINUITY_INVALID'});
    env.FORGE_CONTINUITY_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(goalRef.path))));
    env.FORGE_CONTINUITY_GOAL = goal.id;
    env.FORGE_CONTINUITY_UNIT = unit;
  }
  if (cwd !== undefined && !path.isAbsolute(cwd)) throw Object.assign(new TypeError('launch cwd must be absolute'), {code:'CONTINUITY_INVALID'});
  const displayPath = file => cwd ? path.relative(cwd, file) || '.' : file;
  const prompt = [composeGoalPrompt({ goal, policy, handoff:{...handoff,path:displayPath(handoff.path)} }), `Read ${displayPath(goalRef.path)} (${goalRef.digest}) as the authoritative goal snapshot.`, ...packets.filter(packet=>packet.path!==handoff.path && packet.path!==goalRef.path).map(packet => `Read ${displayPath(packet.path)} (${packet.digest}).`)].join(' ');
  if (policy.provider === 'claude' && [...prompt].length > 4000) throw Object.assign(new RangeError('Claude goal exceeds its 4000-character limit'), {code:'CONTINUITY_INVALID'});
  return { argv: [...policy.argv, ...options], env, goalPrompt: prompt };
}
