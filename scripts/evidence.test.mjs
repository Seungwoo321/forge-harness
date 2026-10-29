import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceCoverage,
  canReuseEvidence,
  compareEvidence,
  evaluateAcceptance,
  gateFingerprint,
  parseGateReport,
  runGate,
} from './lib/evidence.mjs';

test('gate fingerprints are stable across file order and change with content or mode', () => {
  const input = {
    command: ['node', 'test.mjs'],
    config: { reports: 'test.tap' },
    toolVersions: { node: '22' },
  };
  const first = gateFingerprint({ ...input, files: [{ path: 'b', content: '2' }, { path: 'a', content: '1' }] });
  assert.equal(first, gateFingerprint({ ...input, files: [{ path: 'a', content: '1' }, { path: 'b', content: '2' }] }));
  assert.notEqual(first, gateFingerprint({ ...input, files: [{ path: 'a', content: '1', mode: 0o755 }, { path: 'b', content: '2' }] }));
  assert.notEqual(first, gateFingerprint({ ...input, files: [{ path: 'a', content: 'changed' }, { path: 'b', content: '2' }] }));
  assert.equal(gateFingerprint({ ...input, files: [] }), null);
});

test('only successful, current, deterministic evidence is reusable', () => {
  const good = { fingerprint: 'sha256:a', exit: 0, failureClass: null };
  assert.equal(canReuseEvidence(good, 'sha256:a'), true);
  assert.equal(canReuseEvidence({ ...good, exit: 1 }, 'sha256:a'), false);
  assert.equal(canReuseEvidence({ ...good, nondeterministic: true }, 'sha256:a'), false);
  assert.equal(canReuseEvidence(good, 'sha256:b'), false);
  assert.equal(canReuseEvidence(good, null), false);
});

test('TAP coverage comes only from successful named test points', () => {
  const parsed = parseGateReport({
    format: 'tap',
    reportPath: 'report.tap',
    acPattern: 'AC-\\d+',
    result: { exit: 0 },
    report: 'TAP version 13\n1..4\nok 1 - AC-1 accepts input\nnot ok 2 - AC-2 rejects bad input\nok 3 - AC-3 skipped # SKIP unavailable\nok 4 - AC-4 pending # TODO later\n',
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /include a failure/);
  const passing = parseGateReport({
    format: 'tap', reportPath: 'pass.tap', acPattern: 'AC-\\d+', result: { exit: 0 },
    report: 'TAP version 13\n1..3\nok 1 - AC-1 accepts input\nok 2 - AC-2 and AC-3 normalize\nok 3 - unrelated # SKIP platform\n',
  });
  assert.equal(passing.ok, true);
  assert.deepEqual(passing.covers, ['AC-1', 'AC-2', 'AC-3']);
  assert.equal(passing.tests.length, 2);
  assert.match(passing.digest, /^sha256:/);
  const nested = parseGateReport({
    format: 'tap', reportPath: 'nested.tap', acPattern: 'AC-\\d+', result: { exit: 0 },
    report: 'TAP version 13\n# Subtest: suite\n    1..1\n    ok 1 - AC-4 nested check\nok 1 - suite\n1..1\n',
  });
  assert.equal(nested.ok, true);
  assert.deepEqual(nested.covers, ['AC-4']);
});

test('missing or unsupported reports fail closed', () => {
  assert.equal(parseGateReport({ format: 'tap', report: null, result: { exit: 0 } }).ok, false);
  assert.equal(parseGateReport({ format: 'xml', report: 'x', reportPath: 'x', result: { exit: 0 } }).ok, false);
  assert.equal(parseGateReport({ format: 'tap', report: 'TAP version 13\n1..2\nok 1 - AC-1', reportPath: 'x', acPattern: 'AC-\\d+', result: { exit: 0 } }).ok, false);
});

test('complete failing TAP is comparable product evidence while malformed reports are excluded', async () => {
  const stored = [];
  const adapter = {
    latest: async () => stored.at(-1), persist: async (gate, update) => { const record = update(stored.at(-1)); stored.push(record); return record; },
    run: async () => stored.length
      ? { exit: 0, reportPath: 'gate.tap', report: 'TAP version 13\n1..1\nok 1 - AC-1\n' }
      : { exit: 1, failureClass: 'product', reportPath: 'gate.tap', report: 'TAP version 13\n1..1\nnot ok 1 - AC-1\n' },
  };
  const request = { gate: { id: 'tests', command: ['test'], format: 'tap', acPattern: 'AC-\\d+' }, fingerprint: 'sha256:a', adapter };
  assert.equal((await runGate(request)).record.failureClass, 'product');
  assert.equal((await runGate(request)).nondeterministic, true);
  assert.equal(compareEvidence({ fingerprint: 'a', exit: 1 }, { fingerprint: 'a', exit: 0 }).comparable, false);
  assert.equal(compareEvidence({ fingerprint: 'a', exit: 0, covers: ['AC-2', 'AC-1'] },
    { fingerprint: 'a', exit: 0, covers: ['AC-1', 'AC-2'] }).nondeterministic, false);
});

test('module and exec covers count only for successful GateResult', () => {
  const report = 'GateResult';
  const success = parseGateReport({ format: 'module', report, reportPath: 'gate.out', result: { exit: 0, ok: true, covers: ['AC-1'] } });
  const failure = parseGateReport({ format: 'module', report, reportPath: 'gate.out', result: { exit: 1, ok: false, covers: ['AC-2'], failureClass: 'product' } });
  assert.deepEqual(success.covers, ['AC-1']);
  assert.deepEqual(failure.covers, []);
  assert.equal(failure.failureClass, 'product');
  const pending = parseGateReport({ format: 'module', report, reportPath: 'gate.out', result: { exit: 0, ok: true, covers: ['AC-3'], judge: { status: 'pending' } } });
  assert.equal(pending.pending, true);
  assert.deepEqual(pending.covers, []);
});

test('acceptance coverage excludes failed, deferred, dropped, and nondeterministic evidence', () => {
  const result = acceptanceCoverage([
    { id: 'AC-1', status: 'open' },
    { id: 'AC-2', status: 'deferred' },
    { id: 'AC-3', status: 'dropped' },
    { id: 'AC-4', status: 'open' },
  ], [
    { exit: 0, covers: ['AC-1'] },
    { exit: 1, covers: ['AC-4'] },
    { exit: 0, nondeterministic: true, covers: ['AC-4'] },
  ]);
  assert.deepEqual(result, { ok: false, covered: ['AC-1'], uncovered: ['AC-4'] });
});

test('nondeterminism compares eligible results for one fingerprint only', () => {
  assert.deepEqual(compareEvidence(
    { fingerprint: 'sha256:a', exit: 1, failureClass: 'product', covers: [] },
    { fingerprint: 'sha256:a', exit: 0, failureClass: null, covers: ['AC-1'] },
  ), { comparable: true, nondeterministic: true });
  assert.deepEqual(compareEvidence(
    { fingerprint: 'sha256:a', exit: 1, failureClass: 'environment' },
    { fingerprint: 'sha256:a', exit: 0, failureClass: null },
  ), { comparable: false, nondeterministic: false });
});

test('gate runner reuses only passing fingerprints and persists one new record otherwise', async () => {
  let runs = 0;
  const stored = [];
  const adapter = {
    latest: async () => stored.at(-1) ?? null,
    run: async () => {
      runs += 1;
      return { exit: 0, report: 'GateResult', reportPath: 'gate.out', ok: true, covers: ['AC-1'] };
    },
    persist: async (gate, update) => { const record = update(stored.at(-1)); stored.push(record); return record; },
  };
  const request = { gate: { id: 'gate-1', format: 'exec', command: ['node', 'check.mjs'] }, fingerprint: 'sha256:a', adapter };
  assert.equal((await runGate(request)).reused, false);
  assert.equal((await runGate(request)).reused, true);
  assert.equal(runs, 1);
  stored[0].exit = 1;
  assert.equal((await runGate(request)).reused, false);
  assert.equal(runs, 2);
});

test('independent reruns compare matching fingerprints and exclude nondeterministic evidence', async () => {
  const stored = [];
  const adapter = {
    latest: async () => stored.at(-1) ?? null,
    run: async () => ({ exit: 0, report: 'GateResult', reportPath: 'gate.out', ok: true, covers: [stored.length ? 'AC-2' : 'AC-1'] }),
    persist: async (gate, update) => { const record = update(stored.at(-1)); stored.push(record); return record; },
  };
  const request = { gate: { id: 'gate-1', format: 'exec', command: ['node', 'check.mjs'] }, fingerprint: 'sha256:a', adapter };
  await runGate(request);
  const rerun = await runGate({ ...request, independent: true });
  assert.equal(rerun.nondeterministic, true);
  assert.equal(rerun.record.status, 'nondeterministic');
  assert.deepEqual(rerun.record.covers, []);
});

test('acceptance requires current passing gates, complete coverage, and matching ship review when required', () => {
  const target = { head: 'abc', contentFingerprint: 'sha256:content', currentHead: 'abc', currentContentFingerprint: 'sha256:content' };
  const evidence = [{ gate: 'tests', status: 'passed', exit: 0, failureClass: null, covers: ['AC-1'] }];
  assert.equal(evaluateAcceptance({ ...target, requiredGates: ['tests'], acceptance: [{ id: 'AC-1', status: 'open' }], evidence }).ok, true);
  assert.equal(evaluateAcceptance({ ...target, requiredGates: ['tests'], acceptance: [{ id: 'AC-1', status: 'open' }], evidence: [{ ...evidence[0], judge: { status: 'pending' }, status: 'pending' }] }).reason, 'gate judgment is pending');
  assert.equal(evaluateAcceptance({ ...target, requiredGates: ['tests'], acceptance: [{ id: 'AC-1', status: 'open' }], evidence, reviewRequired: true }).reason, 'matching ship review is required');
  assert.equal(evaluateAcceptance({ ...target, currentHead: 'new', requiredGates: ['tests'], acceptance: [{ id: 'AC-1', status: 'open' }], evidence }).nextState, 'SelfGated');
});

test('historical and duplicate passes cannot restore invalidated gate coverage or acceptance', () => {
  const pass = { gate: 'tests', fingerprint: 'fp-a', status: 'passed', exit: 0, failureClass: null, covers: ['AC-1'] };
  const nondeterministic = { ...pass, status: 'nondeterministic', nondeterministic: true, covers: [] };
  for (const evidence of [[pass, { ...pass, fingerprint: 'fp-b', status: 'failed', exit: 1 }], [pass, nondeterministic, pass]]) {
    assert.equal(acceptanceCoverage([{ id: 'AC-1' }], evidence).ok, false);
    assert.equal(evaluateAcceptance({ head: 'h', currentHead: 'h', contentFingerprint: 'c', currentContentFingerprint: 'c', requiredGates: ['tests'], evidence }).ok, false);
  }
});
