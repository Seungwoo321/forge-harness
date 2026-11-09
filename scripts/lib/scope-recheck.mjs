import { realpath } from 'node:fs/promises';
import { effectArgsDigest } from './approvals.mjs';
import { attemptChangedPaths, scopeGuard } from './checkpoint.mjs';
import { attemptsFor } from './stage-attempts.mjs';
import { withGitHeadLock } from './git-head-lock.mjs';

const stale = message => Object.assign(new Error(message), { code: 'STAGE_STALE' });
const generated = finding => finding.kind === 'scope-guard' && finding.severity === 'must-fix' && finding.resolvedAt == null
  && !Object.keys(finding).some(key => !['kind', 'severity', 'paths', 'resolvedAt'].includes(key))
  && Array.isArray(finding.paths) && finding.paths.length > 0;

async function inspectAttribution({ record, adapters, cwd, observed, baseRef }) {
  const git = async args => {
    const result = await adapters.command('git', args, { cwd });
    if (result.exitCode !== 0) throw stale('cannot verify current Git scope attribution');
    return result.stdout.trim();
  };
  const attempts = (record.stages ?? []).flatMap(stage => attemptsFor(record, stage.name));
  const first = attempts.find(attempt => attempt.checkpoint);
  const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (!first || !oid(first.checkpointCommit) || !oid(first.checkpointHead)
    || !oid(observed.head) || !oid(observed.tree) || !oid(observed.base)
    || observed.head !== record.head || observed.contentFingerprint !== record.contentFingerprint
    || observed.contentFingerprint !== `git-tree:${observed.tree}`
    || typeof observed.repo !== 'string' || typeof observed.branch !== 'string') throw stale('scope attribution requires the current submitted target and original checkpoint');
  const root = await git(['rev-parse', '--show-toplevel']);
  const branch = await git(['symbolic-ref', '--short', 'HEAD']);
  const head = await git(['rev-parse', 'HEAD']);
  const resolvedBase = await git(['rev-parse', '--symbolic-full-name', observed.baseRef]);
  if (await realpath(root) !== await realpath(cwd) || await realpath(observed.repo) !== await realpath(root)
    || branch !== observed.branch || head !== observed.head || resolvedBase !== baseRef
    || baseRef === `refs/heads/${branch}` || !baseRef.startsWith('refs/')
    || await git(['merge-base', '--all', head, baseRef]) !== observed.base
    || await git(['rev-parse', `${first.checkpoint}^{commit}`]) !== first.checkpointCommit
    || await git(['rev-parse', `${first.checkpointCommit}^`]) !== first.checkpointHead) throw stale('current repository, branch, base or checkpoint differs');
  await git(['merge-base', '--is-ancestor', first.checkpointHead, observed.base]);
  await git(['merge-base', '--is-ancestor', observed.base, head]);
  const changes = await adapters.checkpoint.inspectChanges({ checkpoint: first.checkpointCommit,
    firstCheckpoint: observed.base, head, exclude: record.policy?.checkpoint?.exclude ?? [] });
  if (changes.head !== head || changes.tree !== observed.tree) throw stale('current scope content differs from submitted evidence');
  const changedPaths = attemptChangedPaths(changes.firstCheckpointDiff);
  if (effectArgsDigest(changedPaths) !== effectArgsDigest(attemptChangedPaths(observed.changedPaths))) throw stale('provider unit diff differs from Git');
  const currentPaths = (await git(['diff', '--no-renames', '--name-only', '-z', observed.base, observed.tree])).split('\0').filter(Boolean);
  const upstreamPaths = attemptChangedPaths((await git(['diff', '--no-renames', '--name-only', '-z', first.checkpointCommit, observed.base])).split('\0').filter(Boolean));
  if (await git(['rev-list', '--min-parents=3', `${observed.base}..${head}`])) throw stale('octopus merge attribution is unsupported');
  const committedPaths = (await git(['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=remerge', `${observed.base}..${head}`])).split('\0').filter(Boolean);
  const unitPaths = attemptChangedPaths([...currentPaths, ...committedPaths, ...attempts.flatMap(attempt => attempt.changedPaths ?? [])]);
  return { head, contentFingerprint: observed.contentFingerprint, repo: root, branch, base: observed.base, baseRef,
    checkpoint: first.checkpointCommit, changedPaths, upstreamPaths, unitPaths };
}

export async function recheckScope({ store, unit, adapters, cwd }) {
  const before = await store.read(unit);
  if (!before) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  const scopeFor = record => ({ goalClass: record.policy.goal.class, scopePaths: record.scopePaths ?? [],
    productPaths: record.productPaths !== undefined ? record.productPaths : record.goal?.productPaths });
  const needsAttribution = (before.findings ?? []).some(finding => generated(finding)
    && !scopeGuard({ ...scopeFor(before), changedPaths: finding.paths }).ok);
  const observed = needsAttribution && typeof adapters.git?.inspectUnit === 'function'
    ? await adapters.git.inspectUnit({ unit, record: before }) : null;
  const useAttribution = observed?.baseRef != null;
  let baseRef;
  if (useAttribution) {
    const result = await adapters.command('git', ['rev-parse', '--symbolic-full-name', observed.baseRef], { cwd });
    baseRef = result.stdout.trim();
    if (result.exitCode !== 0 || !baseRef.startsWith('refs/') || !/^refs\/(heads|remotes)\//.test(baseRef)) throw stale('scope attribution requires an approved Git base reference');
  }
  const unchanged = new Error('scope findings unchanged');
  let result;
  const update = async () => {
    try { await store.update(unit, async record => {
      if (record.revision !== before.revision) throw stale('unit changed during scope recheck');
      if (!['Implementing', 'SelfGated', 'InReview', 'Accepted'].includes(record.state)
        || ['review', 'ops'].includes(record.kind) || record.accepted) {
        throw Object.assign(new Error('scope recheck requires an ongoing implementation before acceptance'), { code: 'INVALID_TRANSITION' });
      }
      if ((record.stages ?? []).some(stage => attemptsFor(record, stage.name).some(attempt => !attempt.endedAt))) {
        throw Object.assign(new Error('scope recheck requires submitted stages'), { code: 'STAGE_ALREADY_OPEN' });
      }
      const scope = scopeFor(record);
      const attribution = useAttribution ? await inspectAttribution({ record, adapters, cwd, observed, baseRef }) : null;
      const upstreamOnly = file => attribution && attribution.upstreamPaths.includes(file) && !attribution.unitPaths.includes(file);
      const resolved = [];
      const resolvedAt = adapters.now();
      const id = `scope-recheck-${record.revision + 1}`;
      const findings = (record.findings ?? []).map((finding, index) => {
        if (!generated(finding) || !scopeGuard({ ...scope,
          changedPaths: finding.paths.filter(file => !upstreamOnly(file)) }).ok) return finding;
        resolved.push({ index, digest: effectArgsDigest(finding), finding });
        return { ...finding, resolvedAt, resolutionRef: id };
      });
      result = { unit, resolved };
      if (!resolved.length) throw unchanged;
      if (attribution) {
        const current = await adapters.git.inspectUnit({ unit, record });
        const verified = await inspectAttribution({ record, adapters, cwd, observed: current, baseRef });
        if (effectArgsDigest(current) !== effectArgsDigest(observed)
          || effectArgsDigest(verified) !== effectArgsDigest(attribution)) throw stale('scope attribution changed during recheck');
      }
      result = { ...result, id, scope, ...(attribution ? { attribution } : {}), resolvedAt, revision: record.revision + 1 };
      return { ...record, findings, scopeRechecks: [...(record.scopeRechecks ?? []), result] };
    }); } catch (error) { if (error !== unchanged) throw error; }
    return result;
  };
  return useAttribution ? withGitHeadLock({ cwd, adapters, refs: [baseRef] }, update) : update();
}
