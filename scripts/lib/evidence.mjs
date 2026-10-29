import { createHash } from 'node:crypto';

const failureClasses = new Set(['product', 'harness', 'environment', 'user-domain', 'unknown']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gateFingerprint({ files, command, config = {}, toolVersions = {} }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const rows = files.map(file => {
    if (typeof file.path !== 'string' || file.path.length === 0 || file.content === undefined) {
      throw new TypeError('fingerprint files require path and content');
    }
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content));
    return { path: file.path, mode: file.mode ?? null, digest: digest(content) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return `sha256:${digest(JSON.stringify(stable({ files: rows, command, config, toolVersions })))}`;
}

export function canReuseEvidence(previous, fingerprint) {
  return Boolean(previous
    && previous.fingerprint === fingerprint
    && fingerprint
    && previous.exit === 0
    && previous.failureClass == null
    && previous.nondeterministic !== true
    && previous.status !== 'pending'
    && previous.judge?.status !== 'pending');
}

function hasPendingJudge(result) {
  return result?.judge?.status === 'pending';
}

function testCasesFromTap(report, acPattern) {
  const regex = new RegExp(acPattern, 'g');
  const tests = [];
  const points = new Map();
  const plans = new Map();
  let lineNo = 0;
  for (const line of report.split(/\r?\n/)) {
    lineNo += 1;
    const plan = line.match(/^(\s*)1\.\.(\d+)\s*$/);
    if (plan) {
      plans.set(plan[1].length, Number(plan[2]));
      continue;
    }
    const point = line.match(/^(\s*)(ok|not ok)\s+(\d+)\s+-\s+(.*)$/i);
    if (!point) continue;
    points.set(point[1].length, (points.get(point[1].length) ?? 0) + 1);
    const nameAndDirective = point[4].match(/^(.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i);
    const name = nameAndDirective[1].trim();
    if (point[2].toLowerCase() !== 'ok' || nameAndDirective[2]) continue;
    const covers = [...name.matchAll(regex)].map(result => result[0]);
    tests.push({ id: String(lineNo), name, covers: [...new Set(covers)] });
  }
  return { tests, points, plans };
}

export function parseGateReport({ format, report, reportPath, acPattern, result }) {
  if (typeof report !== 'string' || typeof reportPath !== 'string' || reportPath.length === 0) {
    return { ok: false, reason: 'gate report is missing' };
  }
  if (!result || !Number.isInteger(result.exit)) return { ok: false, reason: 'gate result is missing an exit status' };
  const reportDigest = `sha256:${digest(report)}`;
  if (format === 'tap') {
    if (typeof acPattern !== 'string' || !acPattern) return { ok: false, reason: 'TAP gate requires an AC ID pattern' };
    let parsedTap;
    try { parsedTap = testCasesFromTap(report, acPattern); } catch (error) {
      return { ok: false, reason: `invalid TAP or AC pattern: ${error.message}` };
    }
    if (!/^TAP version \d+\b/m.test(report) || !/^1\.\.\d+\s*$/m.test(report)) {
      return { ok: false, reason: 'TAP report is incomplete or invalid' };
    }
    const levels = new Set([...parsedTap.plans.keys(), ...parsedTap.points.keys()]);
    const incomplete = [...levels].some(indent => !parsedTap.plans.has(indent)
      || parsedTap.points.get(indent) !== parsedTap.plans.get(indent));
    const hasFailure = /^\s*not ok\s+\d+\s+-/im.test(report);
    if (incomplete) return { ok: false, reason: 'TAP test points do not match the plan' };
    if (hasFailure && result.exit === 0) return { ok: false, reason: 'TAP test points include a failure with a successful exit' };
    if (result.exit === 0 && hasPendingJudge(result)) {
      return { ok: false, pending: true, exit: result.exit, report: reportPath, digest: reportDigest, tests: parsedTap.tests, covers: [], failureClass: null };
    }
    return {
      ok: result.exit === 0,
      exit: result.exit,
      report: reportPath,
      digest: reportDigest,
      tests: parsedTap.tests,
      covers: result.exit === 0 ? [...new Set(parsedTap.tests.flatMap(test => test.covers))] : [],
      failureClass: result.exit === 0 ? null : normalizeFailureClass(result.failureClass),
    };
  }
  if (format === 'module' || format === 'exec') {
    const covers = result.covers ?? [];
    if (!Array.isArray(covers) || covers.some(id => typeof id !== 'string' || !id)) {
      return { ok: false, reason: 'gate covers must be a list of acceptance IDs' };
    }
    if (result.exit === 0 && result.ok === true && hasPendingJudge(result)) {
      return { ok: false, pending: true, exit: result.exit, report: reportPath, digest: reportDigest, tests: [], covers: [], failureClass: null };
    }
    return {
      ok: result.exit === 0 && result.ok === true,
      exit: result.exit,
      report: reportPath,
      digest: reportDigest,
      tests: [],
      covers: result.exit === 0 && result.ok === true ? [...new Set(covers)] : [],
      failureClass: result.exit === 0 && result.ok === true ? null : normalizeFailureClass(result.failureClass),
    };
  }
  return { ok: false, reason: `unsupported report format: ${format}` };
}

function normalizeFailureClass(value) {
  return failureClasses.has(value) ? value : 'unknown';
}

function comparableEvidence(item) {
  return item && Number.isInteger(item.exit) && (item.exit === 0 && item.failureClass == null || item.failureClass === 'product')
    && item.status !== 'pending' && item.judge?.status !== 'pending' && item.nondeterministic !== true;
}

export function compareEvidence(previous, current) {
  if (!previous || !current || previous.fingerprint !== current.fingerprint || !current.fingerprint) {
    return { comparable: false, nondeterministic: false };
  }
  if (!comparableEvidence(previous) || !comparableEvidence(current)) return { comparable: false, nondeterministic: false };
  const signature = item => JSON.stringify(stable({ exit: item.exit, covers: [...new Set(item.covers ?? [])].sort() }));
  const nondeterministic = signature(previous) !== signature(current);
  return { comparable: true, nondeterministic };
}

function currentEvidence(evidence) {
  const latest = new Map();
  for (const item of evidence) if (item) latest.set(item.gate ?? item, item);
  return [...latest.values()].map(item => item.gate && item.fingerprint && evidence.some(other => other?.gate === item.gate
    && other?.fingerprint === item.fingerprint && other?.nondeterministic === true)
    ? { ...item, nondeterministic: true } : item);
}

export function hasInvalidEvidence(evidence = []) {
  return currentEvidence(evidence).some(item => item.exit !== 0 || item.failureClass != null
    || item.nondeterministic === true || ['pending', 'failed', 'nondeterministic'].includes(item.status)
    || item.judge?.status === 'pending');
}

export function acceptanceCoverage(acceptance, evidence) {
  const covered = new Set();
  for (const record of currentEvidence(evidence)) {
    if (!record || record.exit !== 0 || record.nondeterministic === true || record.status === 'pending'
      || record.judge?.status === 'pending' || record.failureClass != null) continue;
    for (const id of record.covers ?? []) covered.add(id);
  }
  const active = acceptance.filter(item => !['deferred', 'dropped'].includes(item.status));
  const uncovered = active.filter(item => !covered.has(item.id)).map(item => item.id);
  return { ok: uncovered.length === 0, covered: [...covered].sort(), uncovered };
}

export async function runGate({ gate, fingerprint, adapter, independent = false }) {
  if (!gate || typeof gate.id !== 'string' || !gate.id) throw new TypeError('gate id is required');
  if (!fingerprint) throw new TypeError('a verifiable gate fingerprint is required');
  if (!adapter || typeof adapter.latest !== 'function' || typeof adapter.run !== 'function' || typeof adapter.persist !== 'function') {
    throw new TypeError('gate adapter must implement latest, run, and persist');
  }
  const prior = await adapter.latest(gate.id);
  if (!independent && canReuseEvidence(prior, fingerprint)) return { record: prior, reused: true };
  const result = await adapter.run(gate);
  const parsed = parseGateReport({ ...gate, ...result, result });
  const resultRecord = {
    gate: gate.id,
    command: gate.command,
    fingerprint,
    exit: Number.isInteger(result?.exit) ? result.exit : 2,
    report: parsed.report ?? null,
    digest: parsed.digest ?? null,
    judge: result?.judge ?? null,
    ...(result?.verdict !== undefined ? { verdict: result.verdict } : {}),
    ...(result?.path !== undefined ? { path: result.path } : {}),
    ...(result?.key !== undefined ? { key: result.key } : {}),
    covers: parsed.ok ? parsed.covers : [],
    tests: parsed.tests ?? [],
    failureClass: parsed.failureClass ?? (parsed.ok || parsed.pending ? null : 'unknown'),
    status: parsed.pending ? 'pending' : parsed.ok ? 'passed' : 'failed',
  };
  // The adapter invokes this updater with current evidence inside its storage transaction.
  const record = await adapter.persist(gate.id, prior => {
    const record = { ...resultRecord };
    const history = new Map((prior?.comparisonHistory ?? []).map(item => [item.fingerprint, item]));
    if (prior?.fingerprint && (comparableEvidence(prior) || prior.nondeterministic === true)) {
      history.set(prior.fingerprint, Object.fromEntries(['fingerprint', 'exit', 'failureClass', 'status', 'covers', 'digest', 'nondeterministic']
        .filter(key => prior[key] !== undefined).map(key => [key, prior[key]])));
    }
    const baseline = history.get(fingerprint);
    const comparison = compareEvidence(baseline, record);
    record.comparison = { ...comparison, previousDigest: baseline?.digest ?? null };
    const nondeterministic = comparison.nondeterministic || baseline?.nondeterministic === true;
    if (nondeterministic) {
      record.nondeterministic = true;
      record.status = 'nondeterministic';
      record.covers = [];
    }
    record.comparisonHistory = [...history.values()];
    return record;
  });
  return { record, reused: false, pending: parsed.pending === true, nondeterministic: record.nondeterministic === true, error: parsed.ok ? null : parsed.pending ? 'judge is pending' : parsed.reason };
}

export function evaluateAcceptance({ acceptance = [], evidence = [], requiredGates = [], head, contentFingerprint, currentHead, currentContentFingerprint, reviewRequired = false, review = null } = {}) {
  evidence = currentEvidence(evidence);
  if (typeof head !== 'string' || !head || typeof contentFingerprint !== 'string' || !contentFingerprint) {
    return { ok: false, reason: 'accepted target is incomplete', uncovered: [] };
  }
  if (head !== currentHead || contentFingerprint !== currentContentFingerprint) {
    return { ok: false, reason: 'accepted target changed', nextState: 'SelfGated', uncovered: [] };
  }
  const pending = requiredGates.filter(id => evidence.some(item => item.gate === id && item.status === 'pending'));
  if (pending.length) return { ok: false, reason: 'gate judgment is pending', pending };
  const missing = requiredGates.filter(id => !evidence.some(item => item.gate === id && item.status === 'passed'
    && item.exit === 0 && item.failureClass == null && item.nondeterministic !== true));
  if (missing.length) return { ok: false, reason: 'required gates have no valid passing evidence', missing };
  const coverage = acceptanceCoverage(acceptance, evidence);
  if (!coverage.ok) return { ok: false, reason: 'acceptance criteria are uncovered', ...coverage };
  if (reviewRequired && (!review || review.verdict !== 'ship' || review.head !== head || review.contentFingerprint !== contentFingerprint
    || (review.findings ?? []).some(finding => finding.severity === 'must-fix' && !finding.resolvedAt))) {
    return { ok: false, reason: 'matching ship review is required' };
  }
  return {
    ok: true,
    accepted: { head, validatedHead: head, contentFingerprint, basis: reviewRequired ? 'review' : 'gates', verdictBy: reviewRequired ? review.verdictBy ?? 'session' : null },
    coverage,
  };
}
