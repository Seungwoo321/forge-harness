import assert from 'node:assert/strict';
import test from 'node:test';
import { profileKinds, resolveReview, selectProfile, validateRiskAssessment } from './lib/profile.mjs';

test('kind profiles expose only their documented states and required gates', () => {
  const common = ['Scoped', 'Implementing', 'SelfGated', 'InReview', 'Accepted', 'Delivering', 'Delivered', 'Closed', 'Blocked', 'Stopped'];
  assert.deepEqual(profileKinds(), ['ops', 'chore', 'impl', 'impl-risk', 'design', 'review']);
  assert.deepEqual(selectProfile('ops').states, ['Scoped', 'Closed', 'Blocked', 'Stopped']);
  assert.deepEqual(selectProfile('review').states, ['InReview', 'Closed', 'Blocked', 'Stopped']);
  for (const kind of ['chore', 'impl', 'impl-risk', 'design']) assert.deepEqual(selectProfile(kind).states, common);
  assert.deepEqual(selectProfile('chore').gates, ['scope-lint-type', 'impact-tests', 'acceptance-coverage']);
  assert.deepEqual(selectProfile('impl').gates, ['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage']);
  assert.deepEqual(selectProfile('impl-risk').gates, [...selectProfile('impl').gates, 'risk-scenarios']);
  assert.deepEqual(selectProfile('design').gates, ['document-consistency', 'acceptance-coverage']);
  assert.deepEqual(selectProfile('review').gates, []);
});

test('review mode, triggers, and owner determine whether a review is required', () => {
  const input = { kind: 'impl-risk', policy: { review: { mode: 'conditional', by: 'user', triggers: ['risk-kind', 'out-of-scope', 'unproven-gate'] } }, requiredGates: ['tests'] };
  assert.deepEqual(resolveReview(input), { required: true, by: 'user', triggeredBy: ['risk-kind', 'unproven-gate'] });
  assert.deepEqual(resolveReview({ ...input, kind: 'impl', policy: { review: { mode: 'conditional', by: 'session', triggers: ['out-of-scope'] } }, findings: [{ kind: 'scope-guard', resolvedAt: 'now' }] }), { required: true, by: 'session', triggeredBy: ['out-of-scope'] });
  assert.deepEqual(resolveReview({ ...input, policy: { review: { mode: 'none', by: 'session', triggers: ['risk-kind'] } } }), { required: false, by: 'session', triggeredBy: [] });
  assert.deepEqual(resolveReview({ ...input, policy: { review: { mode: 'required', by: 'user', triggers: [] } }, requiredGates: [] }), { required: true, by: 'user', triggeredBy: [] });
  assert.throws(() => resolveReview({ kind: 'impl', policy: { review: { mode: 'conditional', by: 'bot', triggers: [] } } }), /invalid review.by/);
});

test('unproven and repeated-signature review triggers require missing gates and duplicate signatures', () => {
  const policy = { review: { mode: 'conditional', by: 'session', triggers: ['unproven-gate', 'repeated-signature'] } };
  const passed = { gate: 'tests', status: 'passed', exit: 0, fingerprint: 'sha256:one', failureClass: null, nondeterministic: false };
  assert.deepEqual(resolveReview({ kind: 'impl', policy, requiredGates: ['tests'], evidence: [passed], failures: [{ signature: 'same' }] }), { required: false, by: 'session', triggeredBy: [] });
  assert.deepEqual(resolveReview({ kind: 'impl', policy, requiredGates: ['tests', 'lint'], evidence: [passed], failures: [{ signature: 'same' }, { signature: 'same' }] }), { required: true, by: 'session', triggeredBy: ['unproven-gate', 'repeated-signature'] });
  assert.deepEqual(resolveReview({ kind: 'impl', policy, requiredGates: ['tests'], evidence: [{ ...passed, nondeterministic: true }] }).triggeredBy, ['unproven-gate']);
});

test('impl-risk requires non-empty assessment and passing risk-gate evidence for each referenced test', () => {
  const assessment = { threats: ['untrusted input'], boundaries: ['local parser'], scenarios: [{ acceptanceRef: 'AC-1', gate: 'risk-scenarios', testId: 'test-risk-input' }] };
  const acceptance = [{ id: 'AC-1' }];
  assert.equal(validateRiskAssessment({ kind: 'impl-risk', riskAssessment: assessment, acceptance }).ok, false);
  const evidence = [{ gate: 'risk-scenarios', status: 'passed', exit: 0, fingerprint: 'sha256:risk', failureClass: null, nondeterministic: false, tests: [{ id: '7', name: 'test-risk-input' }] }];
  assert.deepEqual(validateRiskAssessment({ kind: 'impl-risk', riskAssessment: assessment, acceptance, evidence }), { ok: true, issues: [] });
  assert.equal(validateRiskAssessment({ kind: 'impl-risk', riskAssessment: { ...assessment, scenarios: [{ ...assessment.scenarios[0], testId: 'skipped-test' }] }, acceptance, evidence }).ok, false);
  assert.equal(validateRiskAssessment({ kind: 'impl-risk', riskAssessment: assessment, acceptance, evidence: [{ ...evidence[0], status: 'failed' }] }).ok, false);
  assert.equal(validateRiskAssessment({ kind: 'impl-risk', riskAssessment: { ...assessment, threats: [] }, acceptance, evidence }).ok, false);
  assert.equal(validateRiskAssessment({ kind: 'impl', riskAssessment: null }).ok, true);
});
