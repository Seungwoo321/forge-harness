import { effectArgsDigest } from './approvals.mjs';
import { scopeGuard } from './checkpoint.mjs';

export async function recheckScope({ store, unit, adapters }) {
  const unchanged = new Error('scope findings unchanged');
  let result;
  try { await store.update(unit, record => {
    if (!['Implementing', 'SelfGated', 'InReview', 'Accepted'].includes(record.state)
      || ['review', 'ops'].includes(record.kind) || record.accepted) {
      throw Object.assign(new Error('scope recheck requires an ongoing implementation before acceptance'), { code: 'INVALID_TRANSITION' });
    }
    if ((record.stages ?? []).some(stage => (stage.attempts ?? []).some(attempt => !attempt.endedAt))) {
      throw Object.assign(new Error('scope recheck requires submitted stages'), { code: 'STAGE_ALREADY_OPEN' });
    }
    const scope = { goalClass: record.policy.goal.class, scopePaths: record.scopePaths ?? [],
      productPaths: record.productPaths !== undefined ? record.productPaths : record.goal?.productPaths };
    const resolved = [];
    const resolvedAt = adapters.now();
    const id = `scope-recheck-${record.revision + 1}`;
    const findings = (record.findings ?? []).map((finding, index) => {
      if (finding.kind !== 'scope-guard' || finding.severity !== 'must-fix' || finding.resolvedAt != null
        || Object.keys(finding).some(key => !['kind', 'severity', 'paths', 'resolvedAt'].includes(key))
        || !Array.isArray(finding.paths) || !finding.paths.length
        || !scopeGuard({ ...scope, changedPaths: finding.paths }).ok) return finding;
      resolved.push({ index, digest: effectArgsDigest(finding) });
      return { ...finding, resolvedAt, resolutionRef: id };
    });
    result = { unit, resolved };
    if (!resolved.length) throw unchanged;
    result = { ...result, id, scope, resolvedAt, revision: record.revision + 1 };
    return { ...record, findings, scopeRechecks: [...(record.scopeRechecks ?? []), result] };
  }); } catch (error) { if (error !== unchanged) throw error; }
  return result;
}
