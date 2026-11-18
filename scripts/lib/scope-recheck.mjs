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
    const result = await adapters.command('git', ['--no-replace-objects', ...args], { cwd });
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
  const ancestor = async (a, b) => {
    const result = await adapters.command('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', a, b], { cwd });
    if (![0, 1].includes(result.exitCode)) throw stale('cannot verify scope ancestry');
    return result.exitCode === 0;
  };
  const parents = async commit => (await git(['show', '-s', '--format=%P', commit])).split(' ').filter(Boolean);
  let comparisonBase = observed.base, introduction = null;
  if (comparisonBase === head) {
    // The approved target already contains this delivery. Recover its actual pre-merge base, not a guessed ancestor.
    for (const commit of (await git(['rev-list', '--first-parent', '--reverse', `${first.checkpointHead}..${baseRef}`])).split('\n').filter(Boolean)) {
      const p = await parents(commit);
      if (p.length < 2 || await ancestor(head, p[0])) continue;
      if ((await Promise.all(p.slice(1).map(parent => ancestor(head, parent)))).some(Boolean)) {
        if (p.length !== 2) throw stale('octopus delivery attribution is unsupported');
        comparisonBase = await git(['merge-base', '--all', head, p[0]]);
        introduction = { commit, parents: p };
        break;
      }
    }
    if (!introduction || !oid(comparisonBase)) throw stale('verified target merge introduction is required after delivery');
    await git(['merge-base', '--is-ancestor', first.checkpointHead, comparisonBase]);
  }
  const changes = await adapters.checkpoint.inspectChanges({ checkpoint: first.checkpointCommit,
    firstCheckpoint: observed.base, head, exclude: record.policy?.checkpoint?.exclude ?? [] });
  if (changes.head !== head || changes.contentTree !== observed.tree) throw stale('current scope content differs from submitted evidence');
  const paths = async args => (await git(args)).split('\0').filter(Boolean);
  const providerPaths = attemptChangedPaths(await paths(['diff', '--name-only', '-z', observed.base, changes.contentTree]));
  if (effectArgsDigest(providerPaths) !== effectArgsDigest(attemptChangedPaths(observed.changedPaths))) throw stale('provider unit diff differs from Git');
  const changedPaths = attemptChangedPaths(await paths(['diff', '--name-only', '-z', comparisonBase, changes.contentTree]));
  const currentPaths = await paths(['diff', '--no-renames', '--name-only', '-z', comparisonBase, changes.contentTree]);
  const upstreamPaths = attemptChangedPaths(await paths(['diff', '--no-renames', '--name-only', '-z', first.checkpointCommit, comparisonBase]));
  if (await git(['rev-list', '--min-parents=3', `${comparisonBase}..${head}`])) throw stale('octopus merge attribution is unsupported');
  const committedPaths = await paths(['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=remerge', `${comparisonBase}..${head}`]);
  const last = attempts.filter(attempt => attempt.changedPaths?.length && Number.isSafeInteger(attempt.inputRevision))
    .sort((a, b) => a.inputRevision - b.inputRevision).at(-1);
  const p = await parents(head), inheritedStagePaths = [];
  if (last?.endedAt && last.result === 'done' && last.changedPaths?.length && oid(last.checkpointCommit)
    && p.length === 2 && last.checkpointHead === p[0] && await ancestor(p[1], comparisonBase)
    && await git(['rev-parse', `${head}^{tree}`]) === observed.tree
    && await git(['rev-parse', `${last.checkpoint}^{commit}`]) === last.checkpointCommit
    && await git(['rev-parse', `${last.checkpointCommit}^`]) === last.checkpointHead) {
    const merge = await adapters.command('git', ['--no-replace-objects', 'merge-tree', '--write-tree', ...p], { cwd });
    if (merge.exitCode === 0 && merge.stdout.trim() === observed.tree) {
      const inherited = await paths(['diff', '--no-renames', '--name-only', '-z', p[0], head]);
      for (const file of attemptChangedPaths(last.changedPaths)) {
        if (inherited.includes(file) && upstreamPaths.includes(file) && !committedPaths.includes(file)
          && await git(['ls-tree', '-z', last.checkpointCommit, '--', file]) === await git(['ls-tree', '-z', last.checkpointHead, '--', file]))
          inheritedStagePaths.push(file);
      }
    }
  }
  const unitPaths = attemptChangedPaths([...currentPaths, ...committedPaths,
    ...attempts.flatMap(attempt => (attempt.changedPaths ?? []).filter(file => attempt !== last || !inheritedStagePaths.includes(file)))]);
  return { head, contentFingerprint: observed.contentFingerprint, contentTree: changes.contentTree,
    checkpointTree: changes.tree, excludedPaths: changes.excluded, repo: root, branch, base: observed.base, baseRef,
    checkpoint: first.checkpointCommit, changedPaths, upstreamPaths, unitPaths, comparisonBase, introduction,
    inheritedStagePaths };
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
