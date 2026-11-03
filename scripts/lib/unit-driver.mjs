import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedgerStore, executeEffect } from './ledger.mjs';
import { effectDefinition, prepareEffect, resolvePolicy } from './policy.mjs';
import { resolveStoredPolicy } from './policy-store.mjs';
import { formatCliResult } from './report.mjs';
import { createStageInput, validateStageOutput } from './stage-contract.mjs';
import { createUnitStateStore, transitionRecord } from './unit-state.mjs';
import { resolveReview, selectProfile, validateRiskAssessment } from './profile.mjs';
import { closeDeliveredUnit, createProjectionQueue, projectUnit, reconcileProjectionQueue } from './tracker.mjs';
import { createRecoveryStore, resumeUnitFailure } from './recovery-store.mjs';
import { finishSessionUnit, finalizeSessionUnit } from './session-flow.mjs';
import { createDecisionStore, validateDecision } from './decisions.mjs';
import { acceptanceCoverage, evaluateAcceptance, gateFingerprint, hasInvalidEvidence, runGate } from './evidence.mjs';
import { attributeChanges, createCheckpoint, scopeGuard } from './checkpoint.mjs';
import { classifySessionBoundary } from './classify.mjs';
import { recordApproval, resolveEffectApproval } from './approvals.mjs';
import { acceptedDeliveryMetadata, validateDeliveryContext } from './delivery-flow.mjs';
import { validateAcceptedContent } from './delivery.mjs';
import { resolveFindings } from './finding-resolution.mjs';
import { recheckScope } from './scope-recheck.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { blockGoal, resumeGoal, appendGoalWork } from './continuity-transitions.mjs';
import { commitGoalCompletion } from './continuity-completion.mjs';
import { commitGoalContinuation } from './continuity-finish.mjs';
import { startGoalSession } from './continuity-start.mjs';
import { prepareSessionReturn } from './continuity-return.mjs';
import { stopGoalSession } from './continuity-stop.mjs';
import { changeUnitPolicy } from './unit-policy-change.mjs';
import { attemptsFor } from './stage-attempts.mjs';
import { capturedGateReport, executeCapturedGate, persistCapturedReport } from './gate-execution.mjs';

const controlPlaneFields = new Set([
  'request', 'unit', 'kind', 'goal', 'policy', 'policySources', 'canon', 'tracker', 'isolation',
  'acceptance', 'scopePaths', 'evidence', 'changedPaths', 'diff', 'handoff', 'failures', 'feedback',
  'assumptions', 'openDecisions', 'next',
]);
let temporarySequence = 0;

async function withGitHeadLock({ cwd, adapters }, action) {
  const git = async args => {
    const result = await adapters.command('git', args, { cwd });
    if (result.exitCode !== 0) throw Object.assign(new Error('cannot inspect Git head for stage recovery'), { code: 'STAGE_STALE' });
    return result.stdout.trim();
  };
  if (await git(['rev-parse', '--show-ref-format']) !== 'files') throw Object.assign(new Error('unsupported Git reference storage for stage recovery'), { code: 'STAGE_STALE' });
  const locks = [];
  const acquire = async name => {
    const lock = `${path.resolve(cwd, await git(['rev-parse', '--git-path', name]))}.lock`;
    await mkdir(path.dirname(lock), { recursive: true });
    const handle = await open(lock, 'wx', 0o600);
    locks.push({ lock, handle });
  };
  try {
    await acquire('HEAD');
    const symbolic = await adapters.command('git', ['symbolic-ref', '-q', '--no-recurse', 'HEAD'], { cwd });
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim();
      if (!ref.startsWith('refs/')) throw Object.assign(new Error('invalid symbolic HEAD'), { code: 'STAGE_STALE' });
      await acquire(ref);
      const indirect = await adapters.command('git', ['symbolic-ref', '-q', '--no-recurse', ref], { cwd });
      if (indirect.exitCode !== 1) throw Object.assign(new Error('indirect symbolic HEAD is unsupported for stage recovery'), { code: 'STAGE_STALE' });
    } else if (symbolic.exitCode !== 1) throw Object.assign(new Error('cannot inspect symbolic HEAD'), { code: 'STAGE_STALE' });
    return await action();
  } finally {
    for (const { lock, handle } of locks.reverse()) { await handle.close(); await rm(lock, { force: true }); }
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function contractFile(contractsDir, stage) {
  return path.join(contractsDir, stage, 'contract.json');
}

function targetState(record, stage, output) {
  if (output.status === 'blocked' || output.status === 'needs-decision') return 'Blocked';
  if (output.status === 'needs-diagnosis') return record.state;
  if (stage === 'scope') return 'Implementing';
  if (stage === 'implement') return 'SelfGated';
  if (stage === 'review') return record.kind === 'review' ? 'Closed' : (output.verdict === 'ship' ? 'Accepted' : 'Implementing');
  if (stage === 'handoff') return record.state;
  return record.state;
}

function assertStageState(record, stage) {
  const expected = { scope: ['Scoped'], implement: ['Implementing'], review: ['InReview'], handoff: ['Delivered'] }[stage];
  if (expected && !expected.includes(record.state)) {
    const error = new Error(`${stage} stage cannot open while unit is ${record.state}`);
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
}

async function atomicWrite(file, value) {
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
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJsonFile(file, label, errorCode) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    const error = new Error(`${label} must be a readable JSON file: ${file}`, { cause });
    error.code = errorCode;
    throw error;
  }
}

function readinessFor(contract, record, contracts) {
  const upstreamWriters = {};
  const preparedValues = {};
  for (const field of contract.reads) {
    const writers = contracts.filter(item => item.writes.includes(field)).map(item => item.stage);
    if (controlPlaneFields.has(field)) writers.push('control-plane');
    upstreamWriters[field] = writers;
    if (record[field] !== undefined && record[field] !== null) preparedValues[field] = record[field];
  }
  return { upstreamWriters, preparedValues };
}

async function readContracts(contractsDir) {
  const names = ['scope', 'implement', 'root-cause', 'review', 'handoff'];
  return Promise.all(names.map(async stage => JSON.parse(await readFile(contractFile(contractsDir, stage), 'utf8'))));
}

function firstCheckpoint(record) {
  return (record.stages ?? []).flatMap(stage => attemptsFor(record, stage.name)).find(attempt => attempt.checkpoint)?.checkpoint;
}

function reviewSnapshot(record) {
  if (record?.state === 'InReview' && record.head === undefined && record.contentFingerprint === undefined
    && record.reviewDecision?.required && record.diff === null && record.handoff === null) {
    return { ...record, head: record.reviewDecision.head, contentFingerprint: record.reviewDecision.contentFingerprint };
  }
  return record;
}

async function prepareReviewInput({ record, adapters, stateRoot }) {
  const baseline = firstCheckpoint(record);
  if (typeof adapters.git?.inspectUnit !== 'function') {
    throw Object.assign(new Error('review input preparation requires Git inspection'), { code: 'ADAPTER_MISSING' });
  }
  const target = await adapters.git.inspectUnit({ unit: record.unit, record });
  if (!record.head || !record.contentFingerprint || target.head !== record.head || target.contentFingerprint !== record.contentFingerprint) {
    throw Object.assign(new Error('review content changed since acceptance validation'), { code: 'STAGE_STALE' });
  }
  if (record.diff != null && record.handoff != null) return record;
  if (!baseline || typeof adapters.checkpoint?.inspectChanges !== 'function') {
    throw Object.assign(new Error('review input preparation requires a unit checkpoint'), { code: 'ADAPTER_MISSING' });
  }
  const inspected = await adapters.checkpoint.inspectChanges({
    checkpoint: baseline, firstCheckpoint: baseline, head: record.head,
    exclude: record.policy?.checkpoint?.exclude ?? [], paths: record.changedPaths ?? [],
  });
  if (typeof inspected.patch !== 'string') throw Object.assign(new Error('checkpoint adapter must return the review patch'), { code: 'ADAPTER_INVALID' });
  const diffContent = { base: baseline, head: record.head, paths: record.changedPaths ?? [], patch: inspected.patch };
  const file = path.join(stateRoot, 'units', record.unit, 'stages', `review.${record.revision}.diff.json`);
  let priorDiff;
  let diffBytes;
  try { diffBytes = await readFile(file, 'utf8'); priorDiff = JSON.parse(diffBytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (priorDiff && digest(priorDiff) !== digest(diffContent)) {
    throw Object.assign(new Error('review diff changed before checkpoint recovery'), { code: 'STAGE_STALE' });
  }
  if (!priorDiff) {
    await atomicWrite(file, diffContent);
    diffBytes = `${JSON.stringify(diffContent, null, 2)}\n`;
  }
  const diff = { path: file, digest: `sha256:${createHash('sha256').update(diffBytes).digest('hex')}` };
  const goal = record.continuity?.goalId ? await createContinuityStore(stateRoot).read(record.continuity.goalId) : null;
  if (record.continuity && !goal) throw Object.assign(new Error('review goal is missing'), {code:'CONTINUITY_REQUIRED'});
  const handoff = {
    request: record.request, acceptance: record.acceptance, canon: record.canon,
    ...(goal ? { continuity: { goal: goal.goal, source: goal.source, revision: goal.revision } } : {}),
    changedPaths: record.changedPaths, diff,
    implementation: attemptsFor(record, 'implement').filter(attempt => attempt.endedAt).map(attempt => ({
      attempt: attempt.n, summary: attempt.summary ?? null, outputDigest: attempt.outputDigest,
      changedPaths: attempt.changedPaths ?? [],
    })),
    coverage: record.coverage ?? [], evidence: record.evidence ?? [],
    assumptions: record.assumptions ?? [], openDecisions: record.openDecisions ?? [], next: record.next ?? null,
  };
  return { ...record, diff, handoff };
}

async function otherActiveUnits(stateRoot, currentUnit, adapters) {
  const root = path.join(stateRoot, 'units');
  const names = await readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const store = createUnitStateStore(stateRoot);
  const active = [];
  for (const name of names) {
    if (name === currentUnit) continue;
    const record = await store.read(name).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!record || !['Scoped', 'Implementing', 'SelfGated', 'InReview', 'Accepted', 'Delivering'].includes(record.state)) continue;
    const checkpoint = firstCheckpoint(record);
    if (!checkpoint || typeof adapters.checkpoint?.inspectChanges !== 'function') continue;
    const latest = (record.stages ?? []).flatMap(stage => attemptsFor(record, stage.name)).at(-1);
    if (!latest?.checkpoint) continue;
    const changes = await adapters.checkpoint.inspectChanges({
      unit: record.unit, checkpoint: latest.checkpoint, firstCheckpoint: checkpoint,
      exclude: record.policy?.checkpoint?.exclude ?? [], head: latest.checkpointHead, record,
    });
    active.push({ unit: record.unit, changedPaths: record.changedPaths ?? [], checkpointDiff: changes.firstCheckpointDiff, record });
  }
  return active;
}

function commandFailure(error) {
  const code = error.exitCode ?? (['STAGE_CONTRACT_INVALID', 'CLI_USAGE', 'PROFILE_UNSUPPORTED'].includes(error.code) ? 2
    : ['POLICY_UNSET', 'EFFECT_DENIED', 'EFFECT_APPROVAL_REQUIRED', 'OPEN_DECISIONS', 'DELIVERY_DENIED', 'DELIVERY_PLAN_MISMATCH'].includes(error.code) ? 3
      : error.code === 'REVIEW_REQUIRED' ? 20
      : ['ADAPTER_MISSING', 'ADAPTER_INVALID', 'ENOENT', 'SESSION_CONTRACT_UNSUPPORTED'].includes(error.code) ? 4 : 1);
  return { code, summary: error.message, details: { error: error.code ?? 'UNIT_FAILURE', ...(error.issues ? { issues: error.issues } : {}) } };
}

function acceptanceProgress(record) {
  const acceptance = record.acceptance ?? [];
  const deferred = acceptance.filter(item => item.status === 'deferred').length;
  const dropped = acceptance.filter(item => item.status === 'dropped').length;
  const active = acceptance.filter(item => !['deferred', 'dropped'].includes(item.status));
  const coverage = acceptanceCoverage(acceptance, record.evidence ?? []);
  const covered = active.filter(item => coverage.covered.includes(item.id)).length;
  return {
    total: acceptance.length,
    active: active.length,
    covered,
    uncovered: active.length - covered,
    deferred,
    dropped,
    percent: active.length ? Math.round(covered * 100 / active.length) : null,
  };
}

async function runProgress(stateRoot, unit) {
  const record = await createUnitStateStore(stateRoot).read(unit);
  if (!record) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  const progress = acceptanceProgress(record);
  const effectiveDelivery = record.policyOverrides?.delivery ?? record.policy?.delivery ?? 'none';
  return formatCliResult({ code: 0, summary: `Unit ${unit} acceptance progress`, details: { unit, state: record.state, revision: record.revision, effectiveDelivery, progress, kind: record.kind, canon: record.canon, acceptance: record.acceptance } });
}

function usageError(message) {
  const error = new TypeError(message);
  error.code = 'CLI_USAGE';
  throw error;
}

export function parseUnitArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const key = argument.slice(2);
      if (key === 'non-interactive') {
        if (options[key] !== undefined) usageError(`duplicate option: ${argument}`);
        options[key] = true;
        continue;
      }
      if (!['adapters', 'state-root', 'project-root', 'workspace-root', 'global-root', 'non-interactive', 'output', 'by', 'effect', 'args', 'approval', 'failure', 'snapshot', 'cause-key', 'request', 'decision-id', 'answer', 'user-input', 'gate'].includes(key)) usageError(`unknown option: ${argument}`);
      const value = argv[++index];
      if (!value || value.startsWith('--')) usageError(`missing value for ${argument}`);
      if (options[key] !== undefined) usageError(`duplicate option: ${argument}`);
      options[key] = value;
    } else positional.push(argument);
  }
  return { positional, options };
}

async function getStateRoot(options, cwd, adapters) {
  if (options['state-root']) return path.resolve(cwd, options['state-root']);
  const result = await adapters.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (result.exitCode !== 0) {
    const error = new Error('Git state root unavailable; pass --state-root and --project-root');
    error.code = 'ADAPTER_MISSING';
    throw error;
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) throw new Error('Git returned an empty common directory');
  return path.join(commonDir, 'work-state');
}

async function runStage({ stateRoot, contractsDir, unit, stage, options, adapters, cwd }) {
  const store = createUnitStateStore(stateRoot);
  const record = await store.read(unit);
  if (!record) {
    const error = new Error(`unit not found: ${unit}`);
    error.code = 'UNIT_NOT_FOUND';
    throw error;
  }
  const profile = selectProfile(record.kind);
  const contractByName = new Map((await readContracts(contractsDir)).map(contract => [contract.stage, contract]));
  if (stage === 'open') {
    stage = options.stage;
  }
  if (stage === 'gates') usageError('gates is a control-plane stage and has no StageInput');
  const contract = contractByName.get(stage);
  if (!contract) usageError(`unknown stage: ${stage}`);
  if (!profile.stages.includes(stage) && stage !== 'root-cause') usageError(`stage ${stage} is not in the ${record.kind} profile`);
  if (stage === 'root-cause' && !(record.failures ?? []).length) {
    const error = new Error('root-cause stage requires a recorded failure');
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  if (options.action === 'restart') {
    if (stage !== 'implement' || !options.request) usageError('stage restart requires implement and --request <file>');
    const request = await readJsonFile(path.resolve(cwd, options.request), 'stage restart request', 'CLI_USAGE');
    if (!request || Object.keys(request).sort().join(',') !== 'attempt,checkpointHead,inputDigest,newHead'
      || !Number.isSafeInteger(request.attempt) || request.attempt < 1
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.checkpointHead ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.newHead ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(request.inputDigest ?? '')) usageError('stage restart requires the exact attempt, inputDigest, checkpointHead and newHead');
    if (typeof adapters.command !== 'function' || typeof adapters.checkpoint?.inspectChanges !== 'function') throw Object.assign(new Error('stage restart requires Git checkpoint inspection'), { code: 'ADAPTER_MISSING' });
    let retired;
    await withGitHeadLock({ cwd, adapters }, () => store.update(unit, async current => {
      assertStageState(current, stage);
      const entry = (current.stages ?? []).find(item => item.name === stage);
      const active = entry?.attempts?.find(item => !item.endedAt);
      if (!active || active.n !== request.attempt || active.inputDigest !== request.inputDigest || active.checkpointHead !== request.checkpointHead)
        throw Object.assign(new Error('open stage does not match the requested attempt'), { code: 'STAGE_STALE' });
      const inspected = await adapters.checkpoint.inspectChanges({ unit, stage, attempt: active.n, checkpoint: active.checkpoint,
        firstCheckpoint: firstCheckpoint(current) ?? active.checkpoint, exclude: current.policy?.checkpoint?.exclude ?? [] });
      if (inspected.head !== request.newHead || inspected.head === active.checkpointHead) throw Object.assign(new Error('stage checkpoint is not stale at the requested head'), { code: 'STAGE_STALE' });
      const ancestry = await adapters.command('git', ['merge-base', '--is-ancestor', active.checkpointHead, inspected.head], { cwd });
      const head = await adapters.command('git', ['rev-parse', 'HEAD'], { cwd });
      if (ancestry.exitCode !== 0 || head.exitCode !== 0 || head.stdout.trim() !== inspected.head)
        throw Object.assign(new Error('current head does not safely extend the checkpoint head'), { code: 'STAGE_STALE' });
      retired = active.n;
      return { ...current, stages: current.stages.map(item => item !== entry ? item : { ...item,
        attempts: item.attempts.map(attempt => attempt.n !== active.n ? attempt : { ...attempt, endedAt: adapters.now(), result: 'superseded',
          restart: { checkpointHead: active.checkpointHead, newHead: inspected.head, tree: inspected.tree } }) }) };
    }));
    return { code: 0, summary: `Retired stale ${stage} attempt for ${unit}; open the next attempt`, details: { unit, stage, attempt: retired, newHead: request.newHead } };
  }
  if (options.action === 'open') {
    let opened;
    await store.update(unit, async current => {
      assertStageState(current, stage);
      let target = stage === 'review' && current.kind === 'review'
        ? (typeof current.targetUnit === 'string' ? await store.read(current.targetUnit) : null) : current;
      if (stage === 'review') target = reviewSnapshot(target);
      if (stage === 'review' && current.kind === 'review'
        && (!target || target.state !== 'InReview' || !target.head || !target.contentFingerprint)) {
        const error = new Error('review target must exist in InReview with a current head and content fingerprint');
        error.code = 'REVIEW_TARGET_INVALID';
        throw error;
      }
      const entry = (current.stages ?? []).find(item => item.name === stage);
      const attempts = entry?.attempts ?? [];
      const active = attempts.find(item => !item.endedAt);
      if (active) {
        const error = new Error(`stage already open: ${stage} attempt ${active.n}`);
        error.code = 'STAGE_ALREADY_OPEN';
        throw error;
      }
      const restart = stage === 'implement' ? attempts.at(-1)?.restart : null;
      if (restart) target = { ...target, head: restart.newHead, contentFingerprint: '' };
      const attempt = 1 + Math.max(0, ...attempts.map(item => item.n));
      if (typeof adapters.checkpoint?.createCheckpoint !== 'function') {
        const error = new Error('checkpoint adapter must implement createCheckpoint');
        error.code = 'ADAPTER_MISSING';
        throw error;
      }
      const legacy = stage === 'review' && current.kind !== 'review' && attempt === 1
        && current.diff === null && current.handoff === null
        && current.reviewDecision?.head === target.head && current.reviewDecision?.contentFingerprint === target.contentFingerprint;
      if (stage === 'review') target = await prepareReviewInput({ record: target, adapters, stateRoot });
      let inputRecord = target;
      if (stage === 'root-cause') {
        const references = target.failures ?? [];
        const latestReference = references.at(-1);
        if (!latestReference?.path || references.some(reference => typeof reference?.path !== 'string')) {
          const error = new Error('root-cause stage requires a failure-time snapshot');
          error.code = 'FAILURE_SNAPSHOT_MISSING';
          throw error;
        }
        const recovery = createRecoveryStore(stateRoot);
        const failures = await Promise.all(references.map(reference => recovery.readFailure(unit, path.basename(reference.path, '.json'))));
        const failure = failures.at(-1);
        if (!failure.snapshot || typeof failure.snapshot !== 'object') {
          const error = new Error('root-cause stage requires a failure-time snapshot');
          error.code = 'FAILURE_SNAPSHOT_MISSING';
          throw error;
        }
        inputRecord = {
          ...target,
          failures,
          evidence: failure.snapshot.evidence,
          changedPaths: failure.snapshot.changedPaths,
          diff: failure.snapshot.diff,
        };
      }
      const readiness = readinessFor(contract, inputRecord, [...contractByName.values()]);
      const inputRevision = target.revision;
      const inputCore = {
        unit, targetUnit: stage === 'review' ? (current.targetUnit ?? unit) : unit,
        stage, attempt, inputRevision,
        head: target.head ?? '', contentFingerprint: target.contentFingerprint ?? '',
        data: Object.fromEntries(contract.reads.map(field => [field, readiness.preparedValues[field]])),
      };
      inputCore.inputDigest = digest(inputCore);
      const created = createStageInput(contract, inputCore, readiness);
      if (!created.ok) {
        const error = new Error(`StageInput violates ${stage} contract`);
        error.code = 'STAGE_CONTRACT_INVALID';
        error.issues = created.issues;
        throw error;
      }
      const file = path.join(stateRoot, 'units', unit, 'stages', `${stage}.${attempt}.input.json`);
      let pending;
      try { pending = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pending && digest(pending) !== digest(created.input)) {
        throw Object.assign(new Error('pending stage input changed before checkpoint recovery'), { code: 'STAGE_STALE' });
      }
      if (!pending) await atomicWrite(file, created.input);
      const checkpoint = await createCheckpoint({
        unit, stage, attempt, head: target.head, inputDigest: inputCore.inputDigest, legacy,
        exclude: target.policy?.checkpoint?.exclude ?? [], adapter: adapters.checkpoint,
      });
      if (stage === 'review') {
        const checked = await adapters.git.inspectUnit({ unit: target.unit, record: target });
        if (checked.head !== target.head || checked.contentFingerprint !== target.contentFingerprint) {
          throw Object.assign(new Error('review content changed during checkpoint creation'), { code: 'STAGE_STALE' });
        }
      }
      opened = { attempt, file, inputRevision, inputDigest: inputCore.inputDigest, checkpoint: checkpoint.ref };
      const nextAttempts = [...attempts, {
        n: attempt, checkpoint: checkpoint.ref, checkpointCommit: checkpoint.commit, checkpointHead: checkpoint.head,
        excludedPaths: checkpoint.excluded, inputPath: path.relative(path.join(stateRoot, 'units', unit), file),
        inputDigest: inputCore.inputDigest, inputRevision, startedAt: adapters.now(), endedAt: null,
      }];
      const stages = entry
        ? (current.stages ?? []).map(item => item.name === stage ? { ...item, attempts: nextAttempts } : item)
        : [...(current.stages ?? []), { name: stage, attempts: nextAttempts }];
      return { ...current, ...(stage === 'review' ? {
        ...(current.kind !== 'review' ? { head: target.head, contentFingerprint: target.contentFingerprint } : {}),
        diff: target.diff, handoff: target.handoff,
      } : {}), stages };
    });
    return { code: 0, summary: `Opened ${stage} stage for ${unit}`, details: { unit, stage, attempt: opened.attempt, input: opened.file, checkpoint: opened.checkpoint, profile: profile.kind } };
  }

  const outputPath = options.output;
  if (!outputPath) usageError('unit stage submit requires --output <file>');
  if (stage === 'review' && record.policy?.review?.by === 'user' && options.by !== 'user') {
    usageError('review.by user requires the --by user route');
  }
  if (options.by !== undefined && (stage !== 'review' || options.by !== 'user' || record.policy?.review?.by !== 'user')) {
    usageError('--by user is available only for review.by user');
  }
  const current = await store.read(unit);
  const stageAttempts = attemptsFor(current, stage);
  const active = [...stageAttempts].reverse().find(item => !item.endedAt);
  if (!active) {
    const error = new Error(`no open ${stage} stage for ${unit}`);
    error.code = 'STAGE_NOT_OPEN';
    throw error;
  }
  const inputPath = path.join(stateRoot, 'units', unit, active.inputPath);
  const input = await readJsonFile(inputPath, 'opened StageInput', 'STAGE_CONTRACT_INVALID');
  if (input.inputDigest !== active.inputDigest || input.attempt !== active.n) {
    const error = new Error(`opened ${stage} StageInput no longer matches the Unit Record`);
    error.code = 'STAGE_CONTRACT_INVALID';
    error.issues = [{ path: '$.inputDigest', keyword: 'binding', message: 'must match the recorded StageInput' }];
    throw error;
  }
  const output = await readJsonFile(path.resolve(outputPath), 'StageOutput', 'STAGE_CONTRACT_INVALID');
  const validation = validateStageOutput(contract, input, output);
  if (!validation.ok) {
    const error = new Error(`StageOutput violates ${stage} contract: ${validation.issues.map(issue => issue.path).join(', ')}`);
    error.code = 'STAGE_CONTRACT_INVALID';
    error.issues = validation.issues;
    throw error;
  }
  const reviewTarget = stage === 'review' && current.kind === 'review'
    ? reviewSnapshot(typeof current.targetUnit === 'string' ? await store.read(current.targetUnit) : null) : null;
  if (stage === 'review' && current.kind === 'review' && !reviewTarget) {
    const error = new Error(`review target not found: ${current.targetUnit ?? '<missing>'}`);
    error.code = 'REVIEW_TARGET_INVALID';
    throw error;
  }
  const reviewedRecord = reviewTarget ?? current;
  if (stage === 'review' && current.kind === 'review' && reviewedRecord.continuity?.goalId) {
    const goal = await createContinuityStore(stateRoot).read(reviewedRecord.continuity.goalId);
    const custody = goal?.reviews?.findLast(item => item.unit === unit && item.targetUnit === reviewedRecord.unit);
    if (!custody || current.continuity?.goalId !== reviewedRecord.continuity.goalId || typeof adapters.session?.observe !== 'function')
      throw Object.assign(new Error('independent review session is not registered'), {code:'SESSION_OWNER_MISMATCH'});
    const owner = await adapters.session.observe({cwd:custody.cwd,targetCwd:custody.cwd});
    if (owner.sessionId !== custody.sessionId || owner.incarnationId !== custody.incarnationId || owner.cwd !== custody.cwd)
      throw Object.assign(new Error('review submission must come from the independent review owner'), {code:'SESSION_OWNER_MISMATCH'});
  }
  if (stage === 'review') {
    if (reviewedRecord.state !== 'InReview' || !reviewedRecord.head || !reviewedRecord.contentFingerprint || input.targetUnit !== reviewedRecord.unit
      || input.head !== reviewedRecord.head || input.contentFingerprint !== reviewedRecord.contentFingerprint) {
      const error = new Error('review target changed after the review StageInput was opened');
      error.code = 'STAGE_STALE';
      throw error;
    }
    if (output.reviewedHead !== reviewedRecord.head) {
      const error = new Error('reviewedHead must match the current review target head');
      error.code = 'STAGE_CONTRACT_INVALID';
      error.issues = [{ path: '$.reviewedHead', keyword: 'binding', message: 'must match the target Unit Record head' }];
      throw error;
    }
    if (output.verdict === 'ship' && output.findings.some(finding => finding.severity === 'must-fix' && !finding.resolvedAt)) {
      const error = new Error('a ship verdict cannot include unresolved must-fix findings');
      error.code = 'STAGE_CONTRACT_INVALID';
      error.issues = [{ path: '$.verdict', keyword: 'finding', message: 'must-fix findings block ship' }];
      throw error;
    }
    if (typeof adapters.git?.inspectUnit !== 'function') {
      throw Object.assign(new Error('review submission requires Git inspection'), { code: 'ADAPTER_MISSING' });
    }
    const live = await adapters.git.inspectUnit({ unit: reviewedRecord.unit, record: reviewedRecord });
    if (live?.head !== input.head || live?.contentFingerprint !== input.contentFingerprint) {
      throw Object.assign(new Error('review content changed after the StageInput was opened'), { code: 'STAGE_STALE' });
    }
  }
  if (Array.isArray(output.openDecisions)) {
    const candidate = {
      ...current,
      acceptance: output.acceptance ?? current.acceptance,
      openDecisions: output.openDecisions.map(item => ({ ...item, notifiedAt: null, answer: null })),
    };
    for (const decision of candidate.openDecisions) validateDecision(candidate, decision.id);
  }
  if (typeof adapters.checkpoint?.inspectChanges !== 'function') {
    const error = new Error('checkpoint adapter must implement inspectChanges');
    error.code = 'ADAPTER_MISSING';
    throw error;
  }
  const checkpoint = active.checkpoint;
  const baseline = firstCheckpoint(current) ?? checkpoint;
  const inspected = await adapters.checkpoint.inspectChanges({
    unit, stage, attempt: active.n, checkpoint, firstCheckpoint: baseline,
    exclude: reviewedRecord.policy?.checkpoint?.exclude ?? [], head: active.checkpointHead, record: reviewedRecord,
  });
  const otherUnits = reviewedRecord.isolation === 'shared' ? await otherActiveUnits(stateRoot, unit, adapters) : [];
  const attributed = attributeChanges({
    unit, isolation: reviewedRecord.isolation ?? reviewedRecord.policy?.isolation ?? 'worktree',
    firstCheckpointDiff: inspected.firstCheckpointDiff,
    attemptDiff: inspected.attemptDiff,
    otherUnits,
  });
  const guard = scopeGuard({
    goalClass: reviewedRecord.policy?.goal?.class,
    scopePaths: output.scopePaths ?? reviewedRecord.scopePaths ?? [],
    productPaths: reviewedRecord.productPaths !== undefined ? reviewedRecord.productPaths : reviewedRecord.goal?.productPaths,
    changedPaths: attributed.changedPaths,
  });
  let diagnosisConfirmed = null;
  let resolverCauseKey = null;
  if (stage === 'root-cause' && output.status === 'done') {
    const classifications = [...new Set(output.findings
      .filter(finding => finding.kind === 'diagnosis' && ['product', 'harness', 'environment', 'user-domain'].includes(finding.classification))
      .map(finding => finding.classification))];
    if (classifications.length > 1) {
      const error = new Error('root-cause output cannot assign multiple classes to the active failure');
      error.code = 'STAGE_CONTRACT_INVALID';
      error.issues = [{ path: '$.findings', keyword: 'diagnosis', message: 'must confirm one failure class' }];
      throw error;
    }
    const latestFailure = current.failures?.at(-1);
    if (!latestFailure?.path) {
      const error = new Error('root-cause stage has no persisted failure record');
      error.code = 'DIAGNOSIS_REQUIRED';
      throw error;
    }
    const recovery = createRecoveryStore(stateRoot);
    const failureId = path.basename(latestFailure.path, '.json');
    const failure = await recovery.readFailure(unit, failureId);
    if (failure.class === 'unknown') {
      if (classifications.length !== 1) {
        const error = new Error('root-cause output must confirm the active unknown failure class');
        error.code = 'STAGE_CONTRACT_INVALID';
        error.issues = [{ path: '$.findings', keyword: 'diagnosis', message: 'a diagnosis finding must confirm one known class' }];
        throw error;
      }
      diagnosisConfirmed = await recovery.confirmDiagnosis({ causeKey: failure.causeKey, classification: classifications[0] });
    } else if (failure.class === 'harness' && failure.action === 'resolver') {
      resolverCauseKey = failure.causeKey;
    }
  }
  const to = targetState(current, stage, output);
  let targetUpdated = null;
  if (reviewTarget && output.status === 'done') {
    targetUpdated = await store.update(reviewTarget.unit, target => {
      target = reviewSnapshot(target);
      if (target.state !== 'InReview' || target.head !== input.head || target.contentFingerprint !== input.contentFingerprint) {
        const error = new Error('review target changed before the verdict could be recorded');
        error.code = 'STAGE_STALE';
        throw error;
      }
      if (target.reviewDecision?.submissionId === output.submissionId) return target;
      const reviewDecision = {
        ...(target.reviewDecision ?? { required: true }),
        by: options.by === 'user' ? 'user' : (target.reviewDecision?.by ?? 'session'),
        head: target.head, contentFingerprint: target.contentFingerprint,
        submissionId: output.submissionId,
      };
      const candidate = {
        ...target,
        findings: [...(target.findings ?? []), ...output.findings],
        verdict: output.verdict, reviewedHead: output.reviewedHead,
        reviewDecision,
      };
      return output.verdict === 'fix' ? transitionRecord(candidate, 'Implementing') : candidate;
    });
  }
  const targetProjection = targetUpdated
    ? await projectUnit(targetUpdated, adapters.tracker, createProjectionQueue(stateRoot, adapters))
    : null;
  let updated = await store.update(unit, next => {
    if (next.revision !== current.revision) {
      const error = new Error('unit record changed while the stage output was being inspected');
      error.code = 'STAGE_STALE';
      throw error;
    }
    const stages = (next.stages ?? []).map(item => item.name !== stage ? item : {
      ...item,
      attempts: (item.attempts ?? []).map(attempt => attempt.n === active.n ? {
        ...attempt,
        ...(output.status === 'needs-decision' ? {} : { endedAt: adapters.now() }),
        result: output.status, summary: output.summary, outputDigest: digest(output), submissionId: output.submissionId,
        changedPaths: attributed.attemptPaths,
      } : attempt),
    });
    const writes = Object.fromEntries(contract.writes.filter(field => Object.hasOwn(output, field)).map(field => [field, output[field]]));
    if (reviewTarget) {
      delete writes.findings;
      delete writes.verdict;
      delete writes.reviewedHead;
    }
    if (Array.isArray(writes.findings)) writes.findings = [...(next.findings ?? []), ...writes.findings];
    if (Array.isArray(writes.openDecisions)) writes.openDecisions = writes.openDecisions.map(item => ({ ...item, notifiedAt: null, answer: null }));
    const findings = [...(writes.findings ?? next.findings ?? []), ...attributed.findings, ...(guard.finding ? [guard.finding] : [])];
    const candidate = { ...next, ...writes, ...(stage === 'implement' ? { diff: null, handoff: null } : {}),
      stages, changedPaths: attributed.changedPaths, findings };
    return to === next.state ? candidate : transitionRecord(candidate, to);
  });
  let resolverCompleted = null;
  if (resolverCauseKey) {
    resolverCompleted = await createRecoveryStore(stateRoot).finishResolver({ causeKey: resolverCauseKey });
  }
  for (const finding of attributed.findings) {
    for (const otherUnit of finding.units.filter(id => id !== unit)) {
      await store.update(otherUnit, other => ({ ...other, findings: [...(other.findings ?? []), { ...finding, units: [...finding.units] }] }));
    }
  }
  const escalations = [];
  const notifications = [];
  if (Array.isArray(output.openDecisions)) {
    const decisionStore = createDecisionStore(stateRoot);
    for (const decision of output.openDecisions) {
      if (decision.answer == null && !decision.notifiedAt) {
        const notification = await decisionStore.notify({
          store, unit, decisionId: decision.id, now: adapters.now(),
          threshold: updated.policy?.escalation?.canonReviewAt ?? 5,
        });
        if (!notification.duplicate) notifications.push(notification.notification);
        if (notification.escalation) escalations.push(notification.escalation);
      }
    }
    updated = await store.read(unit);
  }
  const projection = updated.state !== current.state && updated.tracker
    ? await projectUnit(updated, adapters.tracker, createProjectionQueue(stateRoot, adapters))
    : null;
  const decisionRequired = output.status === 'needs-decision';
  return { code: output.status === 'blocked' || decisionRequired || updated.state === 'Stopped' ? 3 : 0, summary: decisionRequired ? `Decision required before ${stage} can continue` : `Submitted ${stage} stage for ${unit}`, details: { unit, stage, state: updated.state, ...(decisionRequired ? { status: 'needs-decision', stageFinished: false } : {}), submissionId: output.submissionId, ...(diagnosisConfirmed ? { diagnosis: { class: diagnosisConfirmed.class, causeKey: diagnosisConfirmed.causeKey } } : {}), ...(resolverCompleted ? { resolver: { causeKey: resolverCompleted.causeKey, active: false } } : {}), ...(reviewTarget ? { targetUnit: reviewTarget.unit, targetState: targetUpdated?.state ?? reviewTarget.state } : {}), ...(targetProjection ? { targetTracker: targetProjection.status } : {}), ...(notifications.length ? { notifications } : {}), ...(escalations.length ? { escalations } : {}), ...(projection ? { tracker: projection.status } : {}) } };
}

async function runEffect({ stateRoot, unit, options, adapters, cwd }) {
  if (!options.effect || !options.args) usageError('unit effect requires --effect <kind> --args <file>');
  if (options.effect.startsWith('session.')) throw Object.assign(new Error('session effects require the managed lifecycle commands'), { code: 'EFFECT_DENIED' });
  const store = createUnitStateStore(stateRoot);
  const record = await store.read(unit);
  if (!record) {
    const error = new Error(`unit not found: ${unit}`);
    error.code = 'UNIT_NOT_FOUND';
    throw error;
  }
  if (!['Implementing', 'Accepted', 'Delivering'].includes(record.state)) {
    const error = new Error('effects require Implementing or an accepted approval target');
    error.code = 'EFFECT_DENIED';
    throw error;
  }
  if (!adapters.effect) {
    const error = new Error('effect adapter unavailable');
    error.code = 'ADAPTER_MISSING';
    throw error;
  }
  const args = await readJsonFile(path.resolve(cwd, options.args), 'effect arguments', 'CLI_USAGE');
  prepareEffect(options.effect, args);
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const context = validateDeliveryContext(await adapters.effectContext?.({ unit, record, effect: options.effect, args }));
  const irreversible = context.irreversible || effectDefinition(options.effect).class === 'E4';
  if (record.state !== 'Implementing' && !irreversible) {
    throw Object.assign(new Error('ordinary effects require Implementing'), { code: 'EFFECT_DENIED' });
  }
  const validateTarget = async current => {
    if (!['Accepted', 'Delivering'].includes(current.state)) {
      throw Object.assign(new Error('E4 effects require an accepted approval target'), { code: 'EFFECT_APPROVAL_REQUIRED' });
    }
    const target = await adapters.git?.inspectUnit({ unit, record: current });
    if (!current.accepted || hasInvalidEvidence(current.evidence) || !validateAcceptedContent(current.accepted, target).valid) {
      throw Object.assign(new Error('approval target no longer matches acceptance'), { code: 'EFFECT_APPROVAL_REQUIRED' });
    }
  };
  const ledgerStore = createLedgerStore(stateRoot);
  const result = await executeEffect({
    unit, effect: options.effect, args, policy, approvalRef: options.approval ?? null,
    context: { ...context, explicitUserInstruction: context.explicitUserInstruction === true },
    // Ledger then Unit custody serializes authorization with policy changes and revocations.
    store: { withLock: (id, action) => ledgerStore.withLock(id, ledger => store.withLock(id, async current => {
      const currentPolicy = resolvePolicy({ unit: current.policyOverrides ?? {}, project: current.policy ?? {} }, { nonInteractive: true }).policy;
      if (digest({ policy: currentPolicy, epoch: current.policyChanges?.at(-1)?.revision ?? 0 }) !== digest({ policy, epoch: record.policyChanges?.at(-1)?.revision ?? 0 })
        || (irreversible ? !['Accepted', 'Delivering'].includes(current.state) : current.state !== 'Implementing')) {
        throw Object.assign(new Error('effect state or policy changed before execution'), { code: irreversible ? 'EFFECT_APPROVAL_REQUIRED' : 'EFFECT_DENIED' });
      }
      if (irreversible) {
        await validateTarget(current);
        await resolveEffectApproval({ record: current, effect: options.effect, args, approvalRef: options.approval, provider: adapters.provider });
        await validateTarget(current);
      }
      return await action(ledger);
    })) },
    adapter: { ...adapters.effect, now: () => adapters.now() },
  });
  return { code: result.status === 'uncertain' ? 3 : 0, summary: `Effect ${options.effect}: ${result.status}`, details: { unit, effect: options.effect, status: result.status, key: result.key } };
}

async function runFailure({ stateRoot, unit, options, adapters }) {
  if (!options.failure) usageError('unit fail requires --failure <file>');
  const failure = await readJsonFile(path.resolve(options.failure), 'failure input', 'CLI_USAGE');
  const store = createUnitStateStore(stateRoot);
  const record = await store.read(unit);
  if (!record) {
    const error = new Error(`unit not found: ${unit}`);
    error.code = 'UNIT_NOT_FOUND';
    throw error;
  }
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const result = await createRecoveryStore(stateRoot).record({
    store, unit, failure: {
      ...failure,
      snapshot: {
        evidence: record.evidence ?? [],
        changedPaths: record.changedPaths ?? [],
        diff: record.diff ?? {},
      },
    },
    retryLimit: policy.retry.maxPerSignature, resolverLimit: policy.retry.maxResolver,
    needsDiagnosis: failure.needsDiagnosis === true, resolverDepth: failure.resolverDepth ?? 0, adapters,
  });
  return {
    code: ['stop', 'defer'].includes(result.decision.action) ? 3 : 0,
    summary: `Failure ${result.decision.action}: ${unit}`,
    details: { unit, failureId: result.failure.id, action: result.decision.action, class: result.failure.class, causeKey: result.failure.causeKey, state: result.record.state, failureRef: result.reference },
  };
}

async function runRetry({ stateRoot, unit, options }) {
  if (!options['cause-key']) usageError('unit retry requires --cause-key <key>');
  const store = createUnitStateStore(stateRoot);
  const record = await store.read(unit);
  if (!record) {
    const error = new Error(`unit not found: ${unit}`);
    error.code = 'UNIT_NOT_FOUND';
    throw error;
  }
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const failure = await createRecoveryStore(stateRoot).reserveRetry({ causeKey: options['cause-key'], retryLimit: policy.retry.maxPerSignature });
  return {
    code: failure.action === 'stop' ? 3 : 0,
    summary: failure.action === 'retry' ? 'Retry reserved' : 'Retry limit reached',
    details: { action: failure.action, cause: failure.cause },
  };
}

async function runResume({ stateRoot, unit, options }) {
  if (!options.snapshot) usageError('unit resume requires --snapshot <file>');
  const snapshot = await readJsonFile(path.resolve(options.snapshot), 'resume snapshot', 'CLI_USAGE');
  const boundary = classifySessionBoundary(snapshot.event);
  const existing = await createUnitStateStore(stateRoot).read(unit);
  if (existing?.continuity?.goalId) {
    const goal = await createContinuityStore(stateRoot).read(existing.continuity.goalId);
    if (!goal || goal.goal.status !== 'active' || !goal.goal.remaining.includes(unit)) throw Object.assign(new Error('goal must be resumed before its unit'), {code:'GOAL_BLOCKED'});
  }
  const pendingLedger = await createLedgerStore(stateRoot).withLock(unit, ledger => ledger.read());
  const result = await resumeUnitFailure({ store: createUnitStateStore(stateRoot), unit, snapshot: { ...snapshot, ledger: pendingLedger } });
  return {
    code: result.recovery?.action === 'resume' ? 0 : 3,
    summary: result.recovery?.action === 'resume' ? `Resumed ${unit} at ${result.stage}` : `Unit ${unit} requires ${result.recovery?.action ?? 'resume inspection'}`,
    details: { unit, state: result.record.state, ...(result.stage ? { stage: result.stage } : {}), ...(boundary ? { event: boundary } : {}), recovery: result.recovery },
  };
}

async function runSessionFinish({ stateRoot, unit, options, adapters }) {
  if (!options.request) usageError('unit finish requires --request <file>');
  const request = await readJsonFile(path.resolve(options.request), 'session finish request', 'CLI_USAGE');
  const outcome = await finishSessionUnit({
    ...request, stateRoot, unit, store: createUnitStateStore(stateRoot),
    trackerAdapter: adapters.tracker, sessionAdapter: adapters.session, adapters,
  });
  const { code, summary, ...details } = outcome;
  return { code, summary, details: { ...details, stateRoot } };
}

function gateEvidenceAdapter(store, unit, adapters, record) {
  return {
    latest: async gate => {
      const prior=(await store.read(unit)).evidence?.filter(item => item.gate === gate).at(-1) ?? null;
      if (prior?.execution?.kind === 'isolated-snapshot-v1' && !(await validCapturedReport(prior))) return {...prior,status:'stale',covers:[]};
      return prior;
    },
    run: async () => { throw Object.assign(new Error('gate execution is not configured'),{code:'ADAPTER_MISSING'}); },
    persist: async (gate, update) => {
      let evidence;
      await store.update(unit, current => {
        evidence = update(current.evidence?.filter(item => item.gate === gate).at(-1) ?? null);
        const updated = { ...current, evidence: [...(current.evidence ?? []), evidence] };
        if (!current.accepted || !hasInvalidEvidence(updated.evidence)) return updated;
        Object.assign(updated, { accepted: null, reviewDecision: null, reviewedHead: null, verdict: null, deliveryResult: null, terminalProjection: null });
        if (['Accepted', 'Delivering', 'Delivered'].includes(current.state)) return transitionRecord(updated, 'SelfGated');
        if (current.state === 'Blocked' && ['Accepted', 'Delivering', 'Delivered'].includes(current.blockedFrom)) updated.blockedFrom = 'SelfGated';
        if (current.state === 'Stopped' && ['Accepted', 'Delivering', 'Delivered'].includes(current.stoppedFrom)) updated.stoppedFrom = 'SelfGated';
        return updated;
      });
      return evidence;
    },
  };
}

async function validCapturedReport(record) {
  if (typeof record?.report !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.digest ?? '')) return false;
  try { return `sha256:${createHash('sha256').update(await readFile(record.report)).digest('hex')}` === record.digest; }
  catch { return false; }
}

async function runIsolatedGate({gate,stateRoot,unit,adapters,cwd}) {
  if (typeof adapters.command !== 'function') throw Object.assign(new Error('isolated gate execution requires the core command adapter'),{code:'ADAPTER_MISSING'});
  const directory=await mkdtemp(path.join(os.tmpdir(),'forge-gate-'));
  try {
    const execution=await executeCapturedGate({gate,directory,sourceRoot:cwd,command:adapters.command});
    const parsed=capturedGateReport({gate,execution,reportPath:'captured'});
    const reportPath=await persistCapturedReport({stateRoot:path.resolve(stateRoot),unit,content:execution.stdout});
    return {...parsed,reportPath};
  } finally {await rm(directory,{recursive:true,force:true});}
}

async function runEvidenceRerun({ stateRoot, unit, gateId, adapters, cwd }) {
  const store = createUnitStateStore(stateRoot);
  const record = await store.read(unit);
  if (!record) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  if (typeof adapters.gates?.describe !== 'function') {
    throw Object.assign(new Error('evidence rerun requires a gate adapter'), { code: 'ADAPTER_MISSING' });
  }
  const gate = await adapters.gates.describe(gateId, { unit, record });
  if (!gate || gate.id !== gateId) throw Object.assign(new Error(`gate adapter did not describe ${gateId}`), { code: 'ADAPTER_INVALID' });
  let applicabilityBytes;
  if (gate.applicability) {
    applicabilityBytes = await readFile(path.join(cwd, 'package.json'));
    const described = gate.files?.filter(file => file.path === 'package.json');
    if (described?.length !== 1 || !applicabilityBytes.equals(Buffer.from(described[0].content))) throw Object.assign(new Error(`gate ${gateId} applicability does not match project package.json`), { code: 'ADAPTER_INVALID' });
  }
  const fingerprint = gateFingerprint(gate);
  const adapter = gateEvidenceAdapter(store, unit, adapters, record);
  const prior = await adapter.latest(gateId);
  if (!fingerprint || !prior || prior.fingerprint !== fingerprint) {
    throw Object.assign(new Error('independent rerun requires existing evidence with the same inputs'), { code: 'EVIDENCE_STALE' });
  }
  adapter.run = async () => {
    const result = gate.applicability
      ? { exit: 0, ok: true, report: applicabilityBytes.toString('utf8'), reportPath: 'package.json', covers: [] }
      : await runIsolatedGate({gate,stateRoot,unit,adapters,cwd});
    const checked = await adapters.gates.describe(gateId, { unit, record });
    if (!checked || checked.id !== gateId || gateFingerprint(checked) !== fingerprint
      || gate.applicability && !(await readFile(path.join(cwd, 'package.json'))).equals(applicabilityBytes)) {
      return { ...result, exit: 1, ok: false, failureClass: 'harness' };
    }
    return result;
  };
  const outcome = await runGate({ gate, fingerprint, adapter, independent: true, enforceSnapshot: true });
  return formatCliResult({ code: outcome.nondeterministic ? 4 : outcome.pending ? 3 : ['passed','not-applicable'].includes(outcome.record.status) ? 0 : 1,
    summary: `Evidence ${gateId}: ${outcome.record.status}`, details: { unit, ...outcome } });
}

async function runAcceptance({ stateRoot, unit, adapters, cwd }) {
  const store = createUnitStateStore(stateRoot);
  let record = await store.read(unit);
  if (!record) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  if (!['SelfGated', 'InReview', 'Accepted'].includes(record.state)) {
    throw Object.assign(new Error(`acceptance cannot run while unit is ${record.state}`), { code: 'INVALID_TRANSITION' });
  }
  if (typeof adapters.git?.inspectUnit !== 'function' || typeof adapters.gates?.describe !== 'function') {
    throw Object.assign(new Error('acceptance requires Git and gate adapters'), { code: 'ADAPTER_MISSING' });
  }
  const profile = selectProfile(record.kind);
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  const policyDigest = digest({ policy, epoch: record.policyChanges?.at(-1)?.revision ?? 0 });
  const policyMatches = current => digest({ policy: resolvePolicy({ unit: current.policyOverrides ?? {}, project: current.policy ?? {} }, { nonInteractive: true }).policy,
    epoch: current.policyChanges?.at(-1)?.revision ?? 0 }) === policyDigest;
  const target = await adapters.git.inspectUnit({ unit, record });
  if (typeof target?.head !== 'string' || !target.head || typeof target.contentFingerprint !== 'string' || !target.contentFingerprint) {
    throw Object.assign(new Error('Git adapter must return the unit head and content fingerprint'), { code: 'ADAPTER_INVALID' });
  }
  const gateFingerprints = new Map();
  for (const gateId of profile.gates) {
    const gate = await adapters.gates.describe(gateId, { unit, record });
    if (!gate || gate.id !== gateId) throw Object.assign(new Error(`gate adapter did not describe ${gateId}`), { code: 'ADAPTER_INVALID' });
    let applicabilityBytes;
    if (gate.applicability) {
      const actual = await readFile(path.join(cwd, 'package.json'));
      applicabilityBytes = actual;
      const described = gate.files?.filter(file => file.path === 'package.json');
      if (described?.length !== 1 || !actual.equals(Buffer.from(described[0].content))) throw Object.assign(new Error(`gate ${gateId} applicability does not match project package.json`), { code: 'ADAPTER_INVALID' });
    }
    const fingerprint = gateFingerprint(gate);
    if (!fingerprint) throw Object.assign(new Error(`gate ${gateId} has no fingerprint inputs`), { code: 'ADAPTER_INVALID' });
    gateFingerprints.set(gateId, fingerprint);
    const gateAdapter = gateEvidenceAdapter(store, unit, adapters, record);
    const executeGate = gate.applicability
      ? async () => ({ exit: 0, ok: true, report: applicabilityBytes.toString('utf8'), reportPath: 'package.json', covers: [] })
      : async () => runIsolatedGate({gate,stateRoot,unit,adapters,cwd});
    gateAdapter.run = async currentGate => {
      const result = await executeGate(currentGate);
      const checked = await adapters.gates.describe(gateId, { unit, record });
      if (!checked || checked.id !== gateId || gateFingerprint(checked) !== fingerprint
        || gate.applicability && !(await readFile(path.join(cwd, 'package.json'))).equals(applicabilityBytes)) {
        return { ...result, exit: 1, ok: false, failureClass: 'harness' };
      }
      return result;
    };
    await runGate({ gate, fingerprint, adapter: gateAdapter, enforceSnapshot: true });
    const checkedGate = await adapters.gates.describe(gateId, { unit, record });
    if (!checkedGate || checkedGate.id !== gateId || gateFingerprint(checkedGate) !== fingerprint
      || gate.applicability && !(await readFile(path.join(cwd, 'package.json'))).equals(applicabilityBytes)) {
      await store.update(unit, current => {
        const previous=current.evidence?.filter(item=>item.gate === gateId).at(-1);
        const updated = { ...current, evidence: previous ? [...(current.evidence ?? []),{...previous,status:'stale',covers:[]}] : current.evidence,
          accepted: null, reviewDecision: null, reviewedHead: null, verdict: null };
        return ['InReview', 'Accepted'].includes(current.state) ? transitionRecord(updated, 'SelfGated') : updated;
      });
      throw Object.assign(new Error(`gate ${gateId} inputs changed during execution`), { code: 'EVIDENCE_STALE' });
    }
    record = await store.read(unit);
  }
  const checkedTarget = await adapters.git.inspectUnit({ unit, record });
  const reviewResolution = resolveReview({
    kind: record.kind, policy, findings: record.findings ?? [], failures: record.failures ?? [],
    evidence: record.evidence ?? [], requiredGates: profile.gates,
  });
  if (policy.review.mode === 'none' && record.evidence?.some(item => profile.gates.includes(item.gate) && item.status === 'not-applicable')) {
    return formatCliResult({ code: 1, summary: 'Applicability requires independent review; configure the missing check or explicitly change the review policy', details: { unit, state: record.state, reason: 'incompatible applicability and review policy' } });
  }
  const triggers = Object.fromEntries(['risk-kind', 'out-of-scope', 'unproven-gate', 'repeated-signature']
    .map(name => [name, reviewResolution.triggeredBy.includes(name)]));
  const reviewDecision = {
    mode: policy.review.mode, triggers, required: reviewResolution.required,
    by: reviewResolution.by, head: target.head, contentFingerprint: target.contentFingerprint,
  };
  const risk = validateRiskAssessment({
    kind: record.kind, riskAssessment: record.riskAssessment, acceptance: record.acceptance ?? [], evidence: record.evidence ?? [],
  });
  if (!risk.ok) return formatCliResult({ code: 1, summary: 'Risk gate evidence is incomplete', details: { unit, state: record.state, issues: risk.issues } });
  const review = record.reviewedHead ? {
    verdict: record.verdict, head: record.reviewedHead,
    contentFingerprint: record.reviewDecision?.contentFingerprint,
    findings: record.findings ?? [], verdictBy: record.reviewDecision?.by ?? 'session',
  } : null;
  const evaluation = evaluateAcceptance({
    acceptance: record.acceptance ?? [], evidence: record.evidence ?? [], requiredGates: profile.gates,
    head: target.head, contentFingerprint: target.contentFingerprint,
    currentHead: checkedTarget?.head, currentContentFingerprint: checkedTarget?.contentFingerprint,
    reviewRequired: reviewResolution.required, review, findings: record.findings ?? [], enforceSnapshot:true,
  });
  if (!evaluation.ok && evaluation.nextState === 'SelfGated') {
    record = await store.update(unit, current => {
      const updated = { ...current, accepted: null, reviewDecision: null };
      return current.state === 'SelfGated' ? updated : transitionRecord(updated, 'SelfGated');
    });
    return formatCliResult({ code: 1, summary: 'Accepted target changed and requires revalidation', details: { unit, state: record.state, reason: evaluation.reason } });
  }
  if (reviewResolution.required && evaluation.reason === 'matching ship review is required') {
    let policyChanged = false;
    record = await store.update(unit, current => {
      if (!policyMatches(current)) { policyChanged = true; return current; }
      const updated = { ...current, head: target.head, contentFingerprint: target.contentFingerprint,
        ...(current.head !== target.head || current.contentFingerprint !== target.contentFingerprint ? { diff: null, handoff: null } : {}),
        reviewDecision, reviewedHead: null, verdict: null, accepted: null };
      if (current.state === 'InReview') return updated;
      return current.state === 'Accepted'
        ? transitionRecord(transitionRecord(updated, 'SelfGated'), 'InReview') : transitionRecord(updated, 'InReview');
    });
    if (policyChanged) return formatCliResult({ code: 1, summary: 'Policy changed during acceptance; revalidation is required', details: { unit, state: record.state } });
    return formatCliResult({ code: 20, summary: `Independent ${reviewResolution.by} review is required`, details: { unit, state: record.state, reviewDecision } });
  }
  if (!evaluation.ok) {
    const code = evaluation.reason === 'gate judgment is pending' ? 3 : 1;
    return formatCliResult({ code, summary: evaluation.reason, details: { unit, state: record.state, ...evaluation } });
  }
  let acceptedTargetChanged = false;
  let commitFailure = null;
  let acceptedCoverage = evaluation.coverage;
  record = await store.update(unit, async current => {
    if (!policyMatches(current)) { commitFailure = 'Policy changed during acceptance; revalidation is required'; return current; }
    const finalTarget = await adapters.git.inspectUnit({ unit, record: current });
    if (finalTarget?.head !== target.head || finalTarget?.contentFingerprint !== target.contentFingerprint
      || policy.delivery !== 'none' && ['repo', 'branch', 'tree', 'indexTree', 'headTree', 'base'].some(field => finalTarget?.[field] !== target[field])) {
      acceptedTargetChanged = true;
      const updated = {
        ...current, head: finalTarget?.head ?? current.head,
        contentFingerprint: finalTarget?.contentFingerprint ?? current.contentFingerprint,
        accepted: null, reviewDecision: null,
      };
      return current.state === 'SelfGated' ? updated : transitionRecord(updated, 'SelfGated');
    }
    for (const id of profile.gates) {
      const described = await adapters.gates.describe(id, { unit, record: current });
      if (!described || described.id !== id || gateFingerprint(described) !== gateFingerprints.get(id)) { commitFailure = `Gate ${id} inputs changed during acceptance`; return current; }
      if (described.applicability && !(await readFile(path.join(cwd, 'package.json'))).equals(Buffer.from(described.files.find(file => file.path === 'package.json').content))) { commitFailure = `Gate ${id} project configuration changed during acceptance`; return current; }
      const proof=current.evidence?.filter(item=>item.gate === id).at(-1);
      if (!described.applicability && !(await validCapturedReport(proof))) { commitFailure = `Gate ${id} captured report changed during acceptance`; return current; }
    }
    const currentReviewResolution = resolveReview({
      kind: current.kind, policy, findings: current.findings ?? [], failures: current.failures ?? [],
      evidence: current.evidence ?? [], requiredGates: profile.gates,
    });
    const currentRisk = validateRiskAssessment({
      kind: current.kind, riskAssessment: current.riskAssessment, acceptance: current.acceptance ?? [], evidence: current.evidence ?? [],
    });
    const currentEvaluation = evaluateAcceptance({
      acceptance: current.acceptance ?? [], evidence: current.evidence ?? [], requiredGates: profile.gates,
      head: target.head, contentFingerprint: target.contentFingerprint,
      currentHead: finalTarget.head, currentContentFingerprint: finalTarget.contentFingerprint,
      reviewRequired: currentReviewResolution.required, findings: current.findings ?? [], enforceSnapshot:true,
      review: current.reviewedHead ? {
        verdict: current.verdict, head: current.reviewedHead, contentFingerprint: current.reviewDecision?.contentFingerprint,
        findings: current.findings ?? [], verdictBy: current.reviewDecision?.by ?? 'session',
      } : null,
    });
    if (!['SelfGated', 'InReview', 'Accepted'].includes(current.state) || !currentRisk.ok || !currentEvaluation.ok
      || profile.gates.some(id => current.evidence?.filter(item => item.gate === id).at(-1)?.fingerprint !== gateFingerprints.get(id))) {
      commitFailure = currentEvaluation.ok ? 'Acceptance inputs changed during validation' : currentEvaluation.reason;
      return current;
    }
    acceptedCoverage = currentEvaluation.coverage;
    const accepted = { ...currentEvaluation.accepted, contentFingerprint: target.contentFingerprint, head: target.head,
      ...(policy.delivery !== 'none' ? acceptedDeliveryMetadata(target) : {}) };
    const currentReviewDecision = { ...reviewDecision, required: currentReviewResolution.required, by: currentReviewResolution.by,
      triggers: Object.fromEntries(Object.keys(triggers).map(name => [name, currentReviewResolution.triggeredBy.includes(name)])) };
    const updated = { ...current, head: target.head, contentFingerprint: target.contentFingerprint, accepted, reviewDecision: currentReviewDecision };
    return current.state === 'Accepted' ? updated : transitionRecord(updated, 'Accepted');
  });
  if (acceptedTargetChanged) {
    const projection = record.tracker ? await projectUnit(record, adapters.tracker, createProjectionQueue(stateRoot, adapters)) : null;
    return formatCliResult({ code: 1, summary: 'Accepted target changed during acceptance and requires revalidation', details: { unit, state: record.state, ...(projection ? { tracker: projection.status } : {}) } });
  }
  if (commitFailure) return formatCliResult({ code: 1, summary: commitFailure, details: { unit, state: record.state } });
  const projection = record.tracker ? await projectUnit(record, adapters.tracker, createProjectionQueue(stateRoot, adapters)) : null;
  return formatCliResult({ code: 0, summary: `Unit ${unit} accepted`, details: { unit, state: record.state, accepted: record.accepted, coverage: acceptedCoverage, ...(projection ? { tracker: projection.status } : {}) } });
}

async function runUnitStart({ stateRoot, unit, options, cwd }) {
  if (!options.request) usageError('unit start requires --request <file>');
  const request = await readJsonFile(path.resolve(cwd, options.request), 'unit start request', 'CLI_USAGE');
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.kind !== 'string' || typeof request.request?.text !== 'string' || !request.request.text.trim()
    || typeof request.request.userInputRef !== 'string' || !request.request.userInputRef.trim()) {
    const error = new Error('unit start request requires kind and request text/userInputRef');
    error.code = 'CLI_USAGE';
    throw error;
  }
  if (request.unit !== undefined && request.unit !== unit) {
    const error = new Error('unit start request unit must match the command unit');
    error.code = 'CLI_USAGE';
    throw error;
  }
  const profile = selectProfile(request.kind);
  if ((request.policyOverrides !== undefined && (!request.policyOverrides || typeof request.policyOverrides !== 'object' || Array.isArray(request.policyOverrides)))
    || (request.userOverrides !== undefined && (!request.userOverrides || typeof request.userOverrides !== 'object' || Array.isArray(request.userOverrides)))) {
    const error = new Error('unit and user policy overrides must be objects');
    error.code = 'CLI_USAGE';
    throw error;
  }
  if (request.kind === 'review' && (typeof request.targetUnit !== 'string' || !request.targetUnit)) {
    const error = new Error('review unit start requires targetUnit');
    error.code = 'CLI_USAGE';
    throw error;
  }

  const store = createUnitStateStore(stateRoot);
  const reviewTarget = request.kind === 'review' ? await store.read(request.targetUnit) : null;
  const goalId = request.goalId ?? reviewTarget?.continuity?.goalId;
  if (request.kind === 'review' && reviewTarget?.continuity?.goalId && goalId !== reviewTarget.continuity.goalId)
    throw Object.assign(new Error('review must use its target goal'), {code:'CONTINUITY_INVALID'});
  const previous = await store.read(unit);
  if (previous) {
    if (previous.kind !== request.kind || previous.request?.text !== request.request.text
      || previous.request?.userInputRef !== request.request.userInputRef
      || (previous.continuity?.goalId ?? null) !== (goalId ?? null)) {
      const error = new Error(`unit already exists with a different start request: ${unit}`);
      error.code = 'UNIT_START_CONFLICT';
      throw error;
    }
    return { code: 0, summary: `Resumed unit ${unit}`, details: { unit, state: previous.state, kind: previous.kind, goal: previous.goal, resumed: true } };
  }

  const projectRoot = path.resolve(cwd, options['project-root'] ?? '.');
  const policy = await resolveStoredPolicy({
    stateRoot, projectRoot,
    ...(options['workspace-root'] ? { workspaceRoot: path.resolve(cwd, options['workspace-root']) } : {}),
    ...(options['global-root'] ? { globalRoot: path.resolve(cwd, options['global-root']) } : {}),
    unit: request.policyOverrides ?? {}, user: request.userOverrides ?? {},
    nonInteractive: options['non-interactive'] === true,
  });
  let continuity;
  if (goalId !== undefined) {
    continuity = await createContinuityStore(stateRoot).read(goalId);
    const goalUnit = request.kind === 'review' ? request.targetUnit : unit;
    if (!continuity || continuity.goal.status !== 'active' || !continuity.goal.remaining.includes(goalUnit)) {
      throw Object.assign(new Error('unit must be listed in an active goal'), { code: 'CONTINUITY_INVALID' });
    }
    if (JSON.stringify(stable(policy.policy.session)) !== JSON.stringify(stable(continuity.policy)))
      throw Object.assign(new Error('resolved execution policy differs from the registered goal'), { code: 'CONTINUITY_STALE' });
    const source = await readFile(continuity.source.path);
    if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== continuity.source.digest)
      throw Object.assign(new Error('goal source changed'), { code: 'CONTINUITY_STALE' });
  }
  const state = request.kind === 'review' ? 'InReview' : 'Scoped';
  const record = await store.create({
    schema: 'harness.unit/1', unit, kind: request.kind, state,
    request: { text: request.request.text, userInputRef: request.request.userInputRef,
      ...(continuity ? { overallGoal: { id: continuity.goal.id, objective: continuity.goal.objective, criteria: continuity.goal.criteria, source: continuity.source } } : {}) },
    ...(request.targetUnit ? { targetUnit: request.targetUnit } : {}),
    ...(request.kind !== 'review' || continuity ? { continuityRequired: true } : {}),
    ...(continuity ? { continuity: { goalId: continuity.goal.id } } : {}),
    goal: { class: policy.policy.goal.class, source: policy.policySources['goal.class'] },
    policy: policy.policy, policySources: policy.policySources,
    ...(request.policyOverrides ? { policyOverrides: request.policyOverrides } : {}),
    ...(request.userOverrides ? { userOverrides: request.userOverrides } : {}),
    ...(request.tracker ? { tracker: request.tracker } : { tracker: null }),
    isolation: request.isolation ?? policy.policy.isolation ?? 'worktree',
    canon: request.canon ?? [], scopePaths: [], acceptance: [], stages: [], changedPaths: [],
    diff: null, handoff: null, feedback: [], evidence: [], findings: [], failures: [],
    assumptions: [], openDecisions: [], coverage: [], riskAssessment: null, verdict: null,
    reviewedHead: null, reviewDecision: null, accepted: null, deliveryResult: null,
    approvals: [], next: null,
  });
  return { code: 0, summary: `Started unit ${unit}`, details: { unit, state: record.state, kind: record.kind, goal: record.goal, profile: profile.kind, resumed: false } };
}

async function runDecision({ stateRoot, unit, action, options, adapters }) {
  if (!options['decision-id']) usageError(`unit decision ${action} requires --decision-id <id>`);
  const store = createUnitStateStore(stateRoot);
  const decisions = createDecisionStore(stateRoot);
  const current = await store.read(unit);
  if (!current) throw Object.assign(new Error(`unit not found: ${unit}`), { code: 'UNIT_NOT_FOUND' });
  const result = action === 'notify'
    ? await decisions.notify({
      store, unit, decisionId: options['decision-id'], now: adapters.now(),
      threshold: (await store.read(unit))?.policy?.escalation?.canonReviewAt ?? 5,
    })
    : action === 'resolve'
      ? await decisions.resolve({ store, unit, decisionId: options['decision-id'], answer: options.answer, now: adapters.now() })
      : usageError('unit decision action must be notify or resolve');
  const updated = result.record ?? result;
  const projection = updated.state !== current.state && updated.tracker
    ? await projectUnit(updated, adapters.tracker, createProjectionQueue(stateRoot, adapters))
    : null;
  return formatCliResult({
    code: action === 'resolve' && updated.state === 'Stopped' ? 3 : 0,
    summary: action === 'notify' ? `Decision ${options['decision-id']} notification recorded` : `Decision ${options['decision-id']} resolved`,
    details: { unit, action, decisionId: options['decision-id'], state: updated.state, ...(result.notification ? { notification: result.notification } : {}), ...(result.escalation ? { escalation: result.escalation } : {}), ...(result.duplicate ? { duplicate: true } : {}), ...(projection ? { tracker: projection.status } : {}) },
  });
}

export async function runUnitCli(argv, { cwd = process.cwd(), stateRoot, contractsDir = path.resolve('skills'), adapters } = {}) {
  try {
    if (!adapters) usageError('unit driver adapters are required');
    const parsed = parseUnitArgs(argv);
    if (parsed.options['state-root'] && !parsed.options['project-root']) usageError('--state-root requires --project-root outside a Git checkout');
    const [noun, subcommand, ...rest] = parsed.positional;
    if (noun === 'evidence') {
      const [unit] = rest;
      if (subcommand !== 'rerun' || rest.length !== 1 || !unit || !parsed.options.gate) usageError('usage: evidence rerun <unit> --gate <id>');
      const effectiveRoot = stateRoot ? path.resolve(stateRoot) : await getStateRoot(parsed.options, cwd, adapters);
      return await runEvidenceRerun({ stateRoot: effectiveRoot, unit, gateId: parsed.options.gate, adapters, cwd });
    }
    if (noun === 'goal') {
      const [id] = rest;
      if (!id || rest.length !== 1 || !['create', 'show', 'block', 'resume', 'reconcile', 'add-work'].includes(subcommand)) usageError('usage: goal create|show <id> [--request <file>]');
      const effectiveRoot = stateRoot ? path.resolve(stateRoot) : await getStateRoot(parsed.options, cwd, adapters);
      const store = createContinuityStore(effectiveRoot);
      if (subcommand === 'show') {
        const goal = await store.read(id);
        if (!goal) throw Object.assign(new Error('goal not found'), { code: 'GOAL_NOT_FOUND' });
        return formatCliResult({ code: 0, summary: `Goal ${id}`, details: { goal } });
      }
      if (subcommand === 'reconcile') {
        const current = await store.read(id);
        if (!current) throw Object.assign(new Error('goal not found'), { code:'GOAL_NOT_FOUND' });
        const unit = current.completion?.unit ?? current.goal.remaining[0];
        if (!unit) throw Object.assign(new Error('goal completion is not ready for reconciliation'), { code:'GOAL_INCOMPLETE' });
        const unitStore = createUnitStateStore(effectiveRoot);
        const record = await unitStore.read(unit);
        const goal = record?.goalContinuation ? await commitGoalContinuation({continuityStore:store,unitStore,goalId:id,unit})
          : await commitGoalCompletion({continuityStore:store,unitStore,goalId:id,unit});
        return formatCliResult({code:0,summary:`Goal ${id} reconciled`,details:{goal}});
      }
      if (subcommand === 'add-work') {
        if (!parsed.options.request) usageError('goal add-work requires --request <file>');
        const request = await readJsonFile(path.resolve(cwd,parsed.options.request), 'goal work request', 'CLI_USAGE');
        const goal = await store.transaction(id, current => appendGoalWork(current,request));
        return formatCliResult({code:0,summary:`Goal ${id} work recorded`,details:{goal}});
      }
      if (['block', 'resume'].includes(subcommand)) {
        if (!parsed.options.request) usageError('goal block|resume requires --request <file>');
        const request = await readJsonFile(path.resolve(cwd, parsed.options.request), 'goal transition request', 'CLI_USAGE');
        const record = await createUnitStateStore(effectiveRoot).read(request.unit);
        if (!record || record.continuity?.goalId !== id || record.state !== 'Stopped')
          throw Object.assign(new Error('goal blocker requires its stopped unit'), {code:'CONTINUITY_INVALID'});
        if (subcommand === 'resume' && !record.sessionFinalization?.closeReceipt?.result?.closed)
          throw Object.assign(new Error('stopped owner must be verified closed before goal resume'), {code:'SESSION_CLOSE_PENDING'});
        if (subcommand === 'block') {
          const failure = record.failures?.at(-1);
          if (!failure || failure.path !== request.evidence || !failure.path.startsWith(`units/${request.unit}/failures/`))
            throw Object.assign(new Error('blocker evidence must reference the recorded unit failure'), {code:'CONTINUITY_INVALID'});
          const bytes = await readFile(path.resolve(effectiveRoot,failure.path));
          if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== failure.digest)
            throw Object.assign(new Error('recorded failure changed'), {code:'CONTINUITY_STALE'});
        }
        const goal = await store.transaction(id, current => subcommand === 'block' ? blockGoal(current, request) : resumeGoal(current, request));
        return formatCliResult({ code: 0, summary: `Goal ${id} ${subcommand === 'block' ? 'blocked' : 'resumed'}`, details: { goal } });
      }
      if (!parsed.options.request) usageError('goal create requires --request <file>');
      const request = await readJsonFile(path.resolve(cwd, parsed.options.request), 'goal request', 'CLI_USAGE');
      if (request.goal?.id !== id) usageError('goal id must match the request');
      const source = await readFile(request.source?.path ?? '');
      if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== request.source?.digest) throw Object.assign(new Error('goal source digest does not match'), { code: 'CONTINUITY_STALE' });
      if (request.policy !== undefined) usageError('execution policy comes from the resolved work policy');
      const projectRoot = path.resolve(cwd, parsed.options['project-root'] ?? '.');
      const resolved = await resolveStoredPolicy({stateRoot:effectiveRoot,projectRoot,
        ...(parsed.options['workspace-root'] ? {workspaceRoot:path.resolve(cwd,parsed.options['workspace-root'])} : {}),
        ...(parsed.options['global-root'] ? {globalRoot:path.resolve(cwd,parsed.options['global-root'])} : {}),
        nonInteractive:parsed.options['non-interactive'] === true});
      const goal = await store.create({goal:request.goal,source:request.source,policy:resolved.policy.session});
      return formatCliResult({ code: 0, summary: `Goal ${id} registered`, details: { goal } });
    }
    if (noun !== 'unit' || !['start', 'scope', 'finding', 'stage', 'effect', 'close', 'reconcile', 'fail', 'retry', 'resume', 'finish', 'finalize', 'decision', 'accept', 'progress', 'approval', 'session-start', 'goal-bind', 'session-stop', 'session-return', 'policy'].includes(subcommand)) usageError('usage: unit start <unit> --request <file>, unit scope recheck <unit>, unit finding resolve <unit> --request <file> --user-input <ref>, unit stage open|submit <unit> <stage>, unit approval record <unit> --request <file> --user-input <ref>, unit effect|fail|retry|resume|close|reconcile|finish|decision|accept|progress');
    const effectiveRoot = stateRoot ? path.resolve(stateRoot) : await getStateRoot(parsed.options, cwd, adapters);
    if (subcommand === 'policy') {
      const [action, unit] = rest;
      if (action !== 'change' || rest.length !== 2 || !unit || !parsed.options.request || !parsed.options['user-input']) usageError('unit policy change requires <unit> --request <file> --user-input <ref>');
      const request = await readJsonFile(path.resolve(cwd, parsed.options.request), 'unit policy change request', 'CLI_USAGE');
      const change = await changeUnitPolicy({ stateRoot: effectiveRoot, store: createUnitStateStore(effectiveRoot), unit, request, userInputRef: parsed.options['user-input'], adapters });
      return formatCliResult({ code: 0, summary: `Policy changed for ${unit}`, details: { unit, change } });
    }
    if (subcommand === 'finding') {
      const [action, unit] = rest;
      if (action !== 'resolve' || rest.length !== 2 || !unit || !parsed.options.request || !parsed.options['user-input']) usageError('unit finding resolve requires <unit> --request <file> --user-input <ref>');
      const request = await readJsonFile(path.resolve(cwd, parsed.options.request), 'finding resolution request', 'CLI_USAGE');
      const contract = await readJsonFile(contractFile(contractsDir, 'review'), 'review contract', 'STAGE_CONTRACT_INVALID');
      const resolution = await resolveFindings({ store: createUnitStateStore(effectiveRoot), stateRoot: effectiveRoot, unit, request,
        userInputRef: parsed.options['user-input'], adapters, cwd, contract });
      return formatCliResult({ code: 0, summary: `Findings resolved for ${unit}`, details: { unit, resolution } });
    }
    if (subcommand === 'scope') {
      const [action, unit] = rest;
      if (action !== 'recheck' || rest.length !== 2 || !unit) usageError('unit scope recheck requires <unit>');
      const recheck = await recheckScope({ store: createUnitStateStore(effectiveRoot), unit, adapters });
      return formatCliResult({ code: 0, summary: `Scope rechecked for ${unit}`, details: { unit, recheck } });
    }
    if (subcommand === 'approval') {
      const [action, unit] = rest;
      if (action !== 'record' || !unit || !parsed.options.request || !parsed.options['user-input']) usageError('unit approval record requires <unit> --request <file> --user-input <ref>');
      const request = await readJsonFile(path.resolve(cwd, parsed.options.request), 'approval request', 'CLI_USAGE');
      const approval = await recordApproval({ store: createUnitStateStore(effectiveRoot), unit, request, userInputRef: parsed.options['user-input'], adapters });
      return formatCliResult({ code: 0, summary: `Approval recorded for ${unit}`, details: { unit, approval } });
    }
    if (subcommand === 'start') {
      const [unit] = rest;
      if (!unit) usageError('unit start requires <unit>');
      return formatCliResult(await runUnitStart({ stateRoot: effectiveRoot, unit, options: parsed.options, cwd }));
    }
    if (subcommand === 'goal-bind') {
      const [unit] = rest;
      if (!unit || rest.length !== 1 || !parsed.options.request) usageError('unit goal-bind requires <unit> --request <file>');
      const request = await readJsonFile(path.resolve(cwd,parsed.options.request), 'goal binding request', 'CLI_USAGE');
      const goal = await createContinuityStore(effectiveRoot).read(request.goalId);
      const store = createUnitStateStore(effectiveRoot);
      const before = await store.read(unit);
      if (!goal || goal.goal.status !== 'active' || !goal.goal.remaining.includes(unit) || !before || before.state !== 'Scoped' || (before.stages ?? []).length !== 0)
        throw Object.assign(new Error('unit must be unscoped and listed in an active goal'), {code:'CONTINUITY_INVALID'});
      const source = await readFile(goal.source.path);
      if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== goal.source.digest || JSON.stringify(stable(before.policy?.session)) !== JSON.stringify(stable(goal.policy)))
        throw Object.assign(new Error('goal source or execution policy differs'), {code:'CONTINUITY_STALE'});
      const record = await store.update(unit, current => {
        if (current.revision !== before.revision || (current.continuity?.goalId && current.continuity.goalId !== goal.goal.id))
          throw Object.assign(new Error('unit changed during goal binding'), {code:'CONTINUITY_STALE'});
        if (current.continuity?.goalId === goal.goal.id && current.continuityRequired) return current;
        return {...current,continuityRequired:true,continuity:{goalId:goal.goal.id},request:{...current.request,overallGoal:{id:goal.goal.id,objective:goal.goal.objective,criteria:goal.goal.criteria,source:goal.source}}};
      });
      return formatCliResult({code:0,summary:`Unit ${unit} bound to goal`,details:{unit,goalId:record.continuity.goalId}});
    }
    if (subcommand === 'session-return') {
      const [unit] = rest;
      if (!unit || rest.length !== 1 || !parsed.options.request) usageError('unit session-return requires <unit> --request <file>');
      const request = await readJsonFile(path.resolve(cwd,parsed.options.request), 'session return request', 'CLI_USAGE');
      const {code,summary,...details} = await prepareSessionReturn({stateRoot:effectiveRoot,unit,request,store:createUnitStateStore(effectiveRoot),adapters,mode:'review'});
      return formatCliResult({code,summary,details:{...details,stateRoot:effectiveRoot}});
    }
    if (subcommand === 'session-stop') {
      const [unit] = rest;
      if (!unit || rest.length !== 1 || !parsed.options.request) usageError('unit session-stop requires <unit> --request <file>');
      const request = await readJsonFile(path.resolve(cwd,parsed.options.request), 'session stop request', 'CLI_USAGE');
      const {code,summary,...details} = await stopGoalSession({stateRoot:effectiveRoot,unit,request,store:createUnitStateStore(effectiveRoot),adapters});
      return formatCliResult({code,summary,details:{...details,stateRoot:effectiveRoot}});
    }
    if (subcommand === 'session-start') {
      const [unit] = rest;
      if (!unit || rest.length !== 1 || !parsed.options.request) usageError('unit session-start requires <unit> --request <file>');
      const request = await readJsonFile(path.resolve(cwd,parsed.options.request), 'session start request', 'CLI_USAGE');
      const result = await startGoalSession({stateRoot:effectiveRoot,unit,request,store:createUnitStateStore(effectiveRoot),adapters});
      return formatCliResult({code:result.status === 'uncertain' ? 3 : 0,summary:`Goal session ${result.status}`,details:{unit,result}});
    }
    if (subcommand === 'effect') {
      const [unit] = rest;
      if (!unit) usageError('unit effect requires <unit>');
      const result = await runEffect({ stateRoot: effectiveRoot, unit, options: parsed.options, adapters, cwd });
      return formatCliResult(result);
    }
    if (subcommand === 'retry') {
      const [unit] = rest;
      if (!unit) usageError('unit retry requires <unit>');
      const result = await runRetry({ stateRoot: effectiveRoot, unit, options: parsed.options });
      return formatCliResult(result);
    }
    if (subcommand === 'finalize') {
      const [unit] = rest;
      if (!unit || rest.length !== 1) usageError('unit finalize requires <unit>');
      const { code, summary, ...details } = await finalizeSessionUnit({ stateRoot: effectiveRoot, store: createUnitStateStore(effectiveRoot), unit, adapters });
      return formatCliResult({ code, summary, details });
    }
    if (subcommand === 'finish') {
      const [unit] = rest;
      if (!unit) usageError('unit finish requires <unit>');
      const result = await runSessionFinish({ stateRoot: effectiveRoot, unit, options: parsed.options, adapters });
      return formatCliResult(result);
    }
    if (subcommand === 'decision') {
      const [action, unit] = rest;
      if (!unit) usageError('unit decision requires notify|resolve <unit>');
      return await runDecision({ stateRoot: effectiveRoot, unit, action, options: parsed.options, adapters });
    }
    if (subcommand === 'accept') {
      const [unit] = rest;
      if (!unit) usageError('unit accept requires <unit>');
      return await runAcceptance({ stateRoot: effectiveRoot, unit, adapters, cwd });
    }
    if (subcommand === 'progress') {
      const [unit] = rest;
      if (!unit) usageError('unit progress requires <unit>');
      return await runProgress(effectiveRoot, unit);
    }
    if (subcommand === 'fail' || subcommand === 'resume') {
      const [unit] = rest;
      if (!unit) usageError(`unit ${subcommand} requires <unit>`);
      const result = subcommand === 'fail'
        ? await runFailure({ stateRoot: effectiveRoot, unit, options: parsed.options, adapters })
        : await runResume({ stateRoot: effectiveRoot, unit, options: parsed.options });
      return formatCliResult(result);
    }
    if (subcommand === 'close') {
      const [unit] = rest;
      if (!unit) usageError('unit close requires <unit>');
      const store = createUnitStateStore(effectiveRoot);
      const record = await closeDeliveredUnit({
        store, unit, adapter: adapters.tracker,
        queue: createProjectionQueue(effectiveRoot, adapters), now: () => adapters.now(), git: adapters.git,
      });
      return formatCliResult({
        code: record.state === 'Closed' ? 0 : record.state === 'SelfGated' ? 1 : 3,
        summary: record.state === 'Closed' ? `Unit ${unit} closed` : record.state === 'SelfGated' ? `Unit ${unit} requires revalidation` : `Unit ${unit} remains ${record.state}`,
        details: { unit, state: record.state, closePending: record.state !== 'Closed' },
      });
    }
    if (subcommand === 'reconcile') {
      const [unit] = rest;
      if (!unit) usageError('unit reconcile requires <unit>');
      const store = createUnitStateStore(effectiveRoot);
      const outcomes = await reconcileProjectionQueue({
        queue: createProjectionQueue(effectiveRoot, adapters), store, adapter: adapters.tracker, git: adapters.git,
      });
      return formatCliResult({ code: outcomes.some(item => item.status === 'queued') ? 3 : 0, summary: `Reconciled ${outcomes.length} tracker projection(s)`, details: { unit, outcomes } });
    }
    const [action, unit, stage] = rest;
    if (!['open', 'submit', 'restart'].includes(action) || !unit || !stage) usageError('usage: unit stage open|submit|restart <unit> <stage>');
    const result = await runStage({ stateRoot: effectiveRoot, contractsDir, unit, stage, options: { ...parsed.options, action }, adapters, cwd });
    return formatCliResult(result);
  } catch (error) {
    return formatCliResult(commandFailure(error));
  }
}
