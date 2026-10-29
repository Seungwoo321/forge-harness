import path from 'node:path';

const stages = new Set(['scope', 'implement', 'gates', 'root-cause', 'review', 'handoff']);

function safeUnit(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit) || unit === '.' || unit === '..') {
    throw new TypeError('unit must be a path-safe identifier');
  }
  return unit;
}

function safeAttempt(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer');
}

function normalizeRepoPath(value) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError('changed paths must be non-empty repository-relative paths');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new TypeError('changed paths cannot escape the repository');
  return normalized.replace(/^\.\//, '');
}

export function checkpointRef({ unit, stage, attempt }) {
  safeUnit(unit);
  safeAttempt(attempt);
  if (!stages.has(stage)) throw new TypeError(`unsupported checkpoint stage: ${stage}`);
  return `refs/harness/${unit}/${stage}.${attempt}`;
}

export async function createCheckpoint({ unit, stage, attempt, exclude = [], head, adapter }) {
  const ref = checkpointRef({ unit, stage, attempt });
  if (!Array.isArray(exclude) || exclude.some(pattern => typeof pattern !== 'string' || !pattern)) {
    throw new TypeError('exclude must contain non-empty glob patterns');
  }
  if (!adapter || typeof adapter.createCheckpoint !== 'function') {
    throw new TypeError('checkpoint adapter must implement createCheckpoint');
  }
  const result = await adapter.createCheckpoint({ ref, exclude: [...new Set(exclude)], respectGitignore: true, head });
  if (!result || typeof result.commit !== 'string' || !result.commit) throw new Error('checkpoint adapter did not return a commit');
  if (result.worktreeChanged !== false || result.indexChanged !== false) {
    throw new Error('checkpoint adapter changed the worktree or real index');
  }
  return { ref, commit: result.commit, ...(result.head ? { head: result.head } : {}), excluded: result.excluded ?? [] };
}

export function attemptChangedPaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError('changed paths must be an array');
  return [...new Set(paths.map(normalizeRepoPath))].sort();
}

export function attributeChanges({ unit, firstCheckpointDiff, attemptDiff, isolation = 'worktree', otherUnits = [] }) {
  safeUnit(unit);
  const unitPaths = new Set(attemptChangedPaths(firstCheckpointDiff));
  const attemptPaths = attemptChangedPaths(attemptDiff);
  if (isolation !== 'worktree' && isolation !== 'shared') throw new TypeError(`unsupported isolation: ${isolation}`);
  if (isolation === 'worktree') return { changedPaths: [...unitPaths].sort(), attemptPaths, findings: [] };

  const otherPaths = new Map();
  for (const other of otherUnits) {
    if (!other || typeof other.unit !== 'string' || !Array.isArray(other.changedPaths) || !Array.isArray(other.checkpointDiff)) {
      throw new TypeError('other shared units require unit, changedPaths, and checkpointDiff');
    }
    for (const value of [...other.changedPaths, ...other.checkpointDiff]) {
      const file = normalizeRepoPath(value);
      const owners = otherPaths.get(file) ?? new Set();
      owners.add(other.unit);
      otherPaths.set(file, owners);
    }
  }
  const overlap = [...unitPaths].filter(file => otherPaths.has(file)).sort();
  const findings = overlap.length ? [{
    kind: 'shared-path',
    severity: 'must-fix',
    units: [unit, ...new Set(overlap.flatMap(file => [...otherPaths.get(file)]))],
    paths: overlap,
  }] : [];
  return {
    changedPaths: [...unitPaths].filter(file => !otherPaths.has(file)).sort(),
    attemptPaths,
    findings,
  };
}

function globRegex(pattern) {
  const value = normalizeRepoPath(pattern);
  let out = '^';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '*' && value[i + 1] === '*') {
      i += 1;
      if (value[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function scopeGuard({ changedPaths, scopePaths = [], productPaths = [], goalClass }) {
  if (!['task', 'product-live', 'product-prelaunch'].includes(goalClass)) throw new TypeError(`unsupported goal class: ${goalClass}`);
  const allowedPaths = goalClass === 'product-prelaunch' ? productPaths : scopePaths;
  if (!Array.isArray(allowedPaths)) throw new TypeError('allowed paths must be an array');
  const paths = attemptChangedPaths(changedPaths);
  const allowed = goalClass === 'product-prelaunch' ? allowedPaths : allowedPaths;
  const patterns = allowed.map(globRegex);
  const outside = paths.filter(file => !patterns.some(pattern => pattern.test(file)));
  return outside.length
    ? { ok: false, finding: { kind: 'scope-guard', severity: 'must-fix', paths: outside, resolvedAt: null } }
    : { ok: true, finding: null };
}
