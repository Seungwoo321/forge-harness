import { mkdir, open, readFile, rename, rm, appendFile, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolvePolicy, validatePolicy } from './policy.mjs';

const levels = new Set(['project', 'workspace', 'global']);
let temporarySequence = 0;

function policyPath(level, { stateRoot, workspaceRoot, globalRoot }) {
  if (level === 'project') return path.join(stateRoot, 'policy.json');
  if (level === 'workspace') {
    if (!workspaceRoot) throw new TypeError('workspace policy requires --workspace-root');
    return path.join(workspaceRoot, '.local', 'work-state', 'policy.json');
  }
  if (level === 'global') {
    if (!globalRoot) throw new TypeError('global policy requires a provider config root');
    return path.join(globalRoot, 'work-state', 'policy.json');
  }
  throw new TypeError(`unsupported policy level: ${level}`);
}

async function readPolicy(file, expectedScope) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.schema !== undefined && data.schema !== 'harness.policy/1') throw new TypeError(`unsupported policy schema: ${data.schema}`);
    if (expectedScope === 'workspace' && data.scope !== 'workspace') return {};
    if (expectedScope === 'project' && data.scope !== undefined && data.scope !== 'project') return {};
    const policy = { ...data };
    for (const field of ['schema', 'scope', 'confirmedBy', 'confirmedAt', 'source', 'goal.defaults']) delete policy[field];
    if (data.goal?.defaults !== undefined) policy.goal = { ...data.goal, defaults: data.goal.defaults };
    validatePolicy(policy);
    return policy;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  temporarySequence += 1;
  const temporary = `${file}.tmp-${process.pid}-${temporarySequence}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function detectPolicyClues({ projectRoot, stateRoot, workspaceRoot, globalRoot, remote, command }) {
  const clues = { projectRoot, remote: remote ?? null, deployment: [], tracker: [], existing: [] };
  for (const name of ['vercel.json', 'netlify.toml', 'fly.toml', 'wrangler.toml', 'render.yaml']) {
    try { await access(path.join(projectRoot, name)); clues.deployment.push(name); } catch {}
  }
  for (const name of ['.github/ISSUE_TEMPLATE', '.linear', '.jira']) {
    try { await access(path.join(projectRoot, name)); clues.tracker.push(name); } catch {}
  }
  const candidates = [
    ['project', policyPath('project', { stateRoot })],
    ...(workspaceRoot ? [['workspace', policyPath('workspace', { workspaceRoot })]] : []),
    ...(globalRoot ? [['global', policyPath('global', { globalRoot })]] : []),
  ];
  for (const [level, file] of candidates) {
    try {
      const policy = await readPolicy(file, level);
      if (Object.keys(policy).length) clues.existing.push({ level, path: file, policy });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const remoteValue = remote ?? (command ? (await command('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot })).stdout.trim() || null : null);
  clues.remote = remoteValue;
  return clues;
}

export async function resolveStoredPolicy({ stateRoot, workspaceRoot, globalRoot, projectRoot, remote, unit = {}, user = {}, nonInteractive = false } = {}) {
  const stored = {};
  for (const level of ['global', 'workspace', 'project']) {
    const rootOptions = { stateRoot, workspaceRoot, globalRoot };
    if (level === 'workspace' && workspaceRoot) {
      try {
        const workspace = await realpath(workspaceRoot);
        const project = await realpath(projectRoot);
        if (workspace === project || !project.startsWith(`${workspace}${path.sep}`)) throw new TypeError('workspace root must be an ancestor of project root');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if ((level === 'workspace' && !workspaceRoot) || (level === 'global' && !globalRoot)) { stored[level] = {}; continue; }
    stored[level] = await readPolicy(policyPath(level, rootOptions), level);
  }
  return resolvePolicy({ ...stored, unit, user }, { projectRoot, remote, nonInteractive });
}

export async function setPolicy({ level, draft, stateRoot, projectRoot, workspaceRoot, globalRoot, change = false, reason, userInputRef, adapters }) {
  if (!levels.has(level)) throw new TypeError('level must be project, workspace, or global');
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new TypeError('draft must be a policy object');
  if (change && (typeof reason !== 'string' || !reason.trim() || typeof userInputRef !== 'string' || !userInputRef.trim())) {
    throw new TypeError('change mode requires reason and userInputRef');
  }
  const policy = draft.policy ?? draft;
  validatePolicy(policy);
  if (policy.goal?.class === undefined && !(level !== 'project' && policy.goal?.defaults)) {
    throw new TypeError('policy draft must set goal.class or goal.defaults');
  }
  const file = policyPath(level, { stateRoot, workspaceRoot, globalRoot });
  if (level === 'workspace') {
    const workspace = await realpath(workspaceRoot);
    const project = await realpath(projectRoot);
    if (workspace === project || !project.startsWith(`${workspace}${path.sep}`)) throw new TypeError('workspace root must be an ancestor of project root');
  }
  const before = await readPolicy(file, level);
  const confirmedAt = adapters.now();
  const confirmedBy = 'user';
  const saved = { schema: 'harness.policy/1', ...(level === 'workspace' ? { scope: 'workspace' } : {}), ...policy, confirmedBy, confirmedAt };
  await atomicJson(file, saved);
  if (change) {
    await mkdir(stateRoot, { recursive: true });
    await appendFile(path.join(stateRoot, 'policy-changes.ndjson'), `${JSON.stringify({
      id: adapters.id(), level, path: file, before, after: policy, reason: reason.trim(),
      userInputRef: userInputRef.trim(), confirmedBy, confirmedAt,
    })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
  return { policy, level, path: file, confirmedBy, confirmedAt, policySources: Object.fromEntries(Object.keys(policy).flatMap(key => {
    const value = policy[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).map(field => [`${key}.${field}`, level]);
    return [[key, level]];
  })) };
}
