const changingStates = ['Scoped', 'Implementing', 'SelfGated', 'InReview', 'Accepted', 'Delivering', 'Delivered', 'Closed', 'Blocked', 'Stopped'];
const changingStages = ['scope', 'implement', 'gates', 'review', 'handoff'];
const profiles = {
  ops: { states: ['Scoped', 'Closed', 'Blocked', 'Stopped'], stages: [], gates: [] },
  chore: { states: changingStates, stages: changingStages, gates: ['scope-lint-type', 'impact-tests', 'acceptance-coverage'] },
  impl: { states: changingStates, stages: changingStages, gates: ['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage'] },
  'impl-risk': { states: changingStates, stages: changingStages, gates: ['typecheck', 'lint', 'tests', 'build', 'acceptance-coverage', 'risk-scenarios'] },
  design: { states: changingStates, stages: changingStages, gates: ['document-consistency', 'acceptance-coverage'] },
  review: { states: ['InReview', 'Closed', 'Blocked', 'Stopped'], stages: ['review'], gates: [] },
};

const validReviewModes = new Set(['none', 'conditional', 'required']);
const validReviewers = new Set(['session', 'user']);

function hasPassedEvidence(evidence, gate) {
  return evidence.some(item => item?.gate === gate
    && item.exit === 0
    && item.status === 'passed'
    && item.failureClass == null
    && item.nondeterministic !== true
    && typeof item.fingerprint === 'string'
    && item.fingerprint.length > 0);
}

/** Resolve whether review opens and preserve the configured review owner. */
export function resolveReview({ kind, policy, findings = [], failures = [], evidence = [], requiredGates = [] }) {
  const review = policy?.review ?? {};
  const mode = review.mode;
  const by = review.by ?? 'session';
  if (!validReviewModes.has(mode)) throw new TypeError(`invalid review.mode: ${mode}`);
  if (!validReviewers.has(by)) throw new TypeError(`invalid review.by: ${by}`);
  const triggers = review.triggers ?? [];
  if (!Array.isArray(triggers) || triggers.some(trigger => typeof trigger !== 'string')) {
    throw new TypeError('review.triggers must be an array of strings');
  }
  const conditions = {
    'risk-kind': kind === 'impl-risk',
    'out-of-scope': findings.some(finding => finding?.kind === 'scope-guard'),
    'unproven-gate': requiredGates.some(gate => !hasPassedEvidence(evidence, gate)),
    'repeated-signature': failures.some((failure, index) => failures
      .slice(0, index).some(previous => previous?.signature === failure?.signature)),
  };
  const triggeredBy = mode === 'conditional' ? triggers.filter(trigger => conditions[trigger] === true) : [];
  return { required: mode === 'required' || (mode === 'conditional' && triggeredBy.length > 0), by, triggeredBy };
}

/** Validate the impl-risk contract and its passing risk-tag test evidence. */
export function validateRiskAssessment({ kind, riskAssessment, acceptance = [], evidence = [] }) {
  const issues = [];
  const add = (path, message) => issues.push({ path, message });
  if (kind !== 'impl-risk') return { ok: true, issues };
  if (!riskAssessment || typeof riskAssessment !== 'object' || Array.isArray(riskAssessment)) {
    return { ok: false, issues: [{ path: '$.riskAssessment', message: 'is required for impl-risk' }] };
  }
  for (const field of ['threats', 'boundaries', 'scenarios']) {
    const value = riskAssessment[field];
    if (!Array.isArray(value) || value.length === 0) add(`$.riskAssessment.${field}`, 'must be a non-empty array');
  }
  const acceptanceIds = new Set(acceptance.map(item => item?.id));
  for (const [index, scenario] of (Array.isArray(riskAssessment.scenarios) ? riskAssessment.scenarios : []).entries()) {
    const at = `$.riskAssessment.scenarios[${index}]`;
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      add(at, 'must be an object');
      continue;
    }
    for (const field of ['acceptanceRef', 'gate', 'testId']) {
      if (typeof scenario[field] !== 'string' || scenario[field].length === 0) add(`${at}.${field}`, 'must be a non-empty string');
    }
    if (typeof scenario.acceptanceRef === 'string' && !acceptanceIds.has(scenario.acceptanceRef)) {
      add(`${at}.acceptanceRef`, 'must identify an acceptance criterion');
    }
    if (scenario.gate !== 'risk-scenarios') add(`${at}.gate`, 'must identify the risk-scenarios gate');
    const passed = hasPassedEvidence(evidence, 'risk-scenarios')
      && evidence.some(item => item?.gate === 'risk-scenarios'
        && item.exit === 0 && item.status === 'passed' && item.failureClass == null
        && item.nondeterministic !== true
        && item.tests?.some(test => test?.id === scenario.testId || test?.name === scenario.testId));
    if (!passed) add(`${at}.testId`, 'must identify a passing test in risk-scenarios evidence');
  }
  return { ok: issues.length === 0, issues };
}

export function selectProfile(kind) {
  const profile = profiles[kind];
  if (!profile) {
    const error = new TypeError(`unsupported unit kind: ${kind}`);
    error.code = 'PROFILE_UNSUPPORTED';
    throw error;
  }
  return structuredClone({ kind, ...profile });
}

export function profileKinds() {
  return Object.keys(profiles);
}
