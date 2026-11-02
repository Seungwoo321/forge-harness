import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { effectArgsDigest, verifyApprovalInput } from './approvals.mjs';
import { validateStageOutput } from './stage-contract.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !['.', '..'].includes(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function reject(message, code = 'FINDING_RESOLUTION_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function hasOpenStage(record) {
  return (record.stages ?? []).some(stage => (stage.attempts ?? []).some(attempt => !attempt.endedAt));
}

function assertRequest(request, userInputRef) {
  if (!fields(request, ['id', 'expectedRevision', 'head', 'contentFingerprint', 'findings', 'review', 'reviewer', 'evidence', 'reason'])
    || !identifier(request.id) || !integer(request.expectedRevision) || !text(request.head) || !text(request.contentFingerprint)
    || !text(request.reviewer) || !text(request.reason) || !text(userInputRef)
    || !Array.isArray(request.findings) || !request.findings.length
    || request.findings.some(item => !fields(item, ['index', 'digest']) || !Number.isSafeInteger(item.index) || item.index < 0 || !sha(item.digest))
    || new Set(request.findings.map(item => item.index)).size !== request.findings.length
    || !fields(request.review, ['unit', 'attempt', 'outputPath', 'outputDigest'])
    || !identifier(request.review.unit) || !integer(request.review.attempt) || !text(request.review.outputPath) || !sha(request.review.outputDigest)
    || !fields(request.evidence, ['path', 'digest']) || !text(request.evidence.path) || !sha(request.evidence.digest)) {
    reject('resolution requires exact findings, current source, completed review, reviewer, evidence and authorization');
  }
}

async function readEvidence(request, cwd) {
  try {
    const output = JSON.parse(await readFile(path.resolve(cwd, request.review.outputPath), 'utf8'));
    const report = await readFile(path.resolve(cwd, request.evidence.path));
    if (effectArgsDigest(output) !== request.review.outputDigest
      || `sha256:${createHash('sha256').update(report).digest('hex')}` !== request.evidence.digest) {
      reject('review output or independent evidence digest does not match');
    }
    return output;
  } catch (error) {
    if (error.code === 'FINDING_RESOLUTION_INVALID') throw error;
    reject('review output and independent evidence must be readable and digest-matching');
  }
}

async function checkReview({ store, stateRoot, record, request, contract, cwd }) {
  const review = request.review.unit === record.unit ? record : await store.read(request.review.unit);
  if (!review || (review !== record && (review.kind !== 'review' || review.targetUnit !== record.unit || review.state !== 'Closed'))
    || hasOpenStage(review)) reject('review must be a completed stage for the exact target');
  const attempts = review.stages?.find(stage => stage.name === 'review')?.attempts ?? [];
  const attempt = attempts.at(-1);
  if (!attempt || attempt.n !== request.review.attempt || !attempt.endedAt || attempt.result !== 'done'
    || attempt.outputDigest !== request.review.outputDigest) reject('review evidence must match the latest completed review attempt');
  const input = JSON.parse(await readFile(path.join(stateRoot, 'units', review.unit, attempt.inputPath), 'utf8'));
  const { inputDigest, ...core } = input;
  if (inputDigest !== attempt.inputDigest || effectArgsDigest(core) !== inputDigest
    || input.unit !== review.unit || input.targetUnit !== record.unit || input.stage !== 'review'
    || input.attempt !== attempt.n || input.inputRevision !== attempt.inputRevision
    || input.head !== request.head || input.contentFingerprint !== request.contentFingerprint) reject('review input does not match the current target');
  if (effectArgsDigest(input.data.acceptance) !== effectArgsDigest(record.acceptance)
    || effectArgsDigest(input.data.evidence) !== effectArgsDigest(record.evidence)) {
    reject('acceptance criteria or gate evidence changed after review', 'FINDING_RESOLUTION_STALE');
  }
  // Review inputs bind the target revision, even for separate review units.
  for (const entry of await readdir(path.join(stateRoot, 'units'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const other = entry.name === record.unit ? record : await store.read(entry.name);
    if (!other) continue;
    if (other.unit !== record.unit && (other.kind !== 'review' || other.targetUnit !== record.unit)) continue;
    for (const stage of other.stages ?? []) {
      for (const item of stage.attempts ?? []) {
        if (other.unit === review.unit && stage.name === 'review' && item.n === attempt.n) continue;
        if (item.inputRevision >= input.inputRevision && ['scope', 'implement', 'review'].includes(stage.name)) {
          reject('a subsequent implementation or review supersedes the supplied review', 'FINDING_RESOLUTION_STALE');
        }
      }
    }
  }
  const output = await readEvidence(request, cwd);
  if (!validateStageOutput(contract, input, output).ok || output.status !== 'done' || output.verdict !== 'ship'
    || output.reviewedHead !== request.head || output.submissionId !== attempt.submissionId
    || output.findings.some(finding => finding.severity === 'must-fix' && !finding.resolvedAt)
    || (record.verdict != null && record.verdict !== 'ship')
    || (record.reviewedHead != null && record.reviewedHead !== request.head)
    || record.reviewDecision?.head !== request.head || record.reviewDecision?.contentFingerprint !== request.contentFingerprint
    || (record.reviewDecision?.submissionId != null && record.reviewDecision.submissionId !== output.submissionId)) {
    reject('resolution requires the current matching ship review');
  }
  return { output, recovered: record.verdict == null || record.reviewedHead == null };
}

function assertSource(record, request, inspected) {
  // Legacy review snapshots keep the authoritative source in reviewDecision.
  const head = record.head ?? record.reviewDecision?.head;
  const fingerprint = record.contentFingerprint ?? record.reviewDecision?.contentFingerprint;
  if (head !== request.head || fingerprint !== request.contentFingerprint
    || inspected?.head !== request.head || inspected?.contentFingerprint !== request.contentFingerprint) {
    reject('resolution source no longer matches the reviewed target', 'FINDING_RESOLUTION_STALE');
  }
}

export async function resolveFindings({ store, stateRoot, unit, request, userInputRef, adapters, cwd, contract }) {
  assertRequest(request, userInputRef);
  const requestDigest = effectArgsDigest({ request, userInputRef });
  const duplicate = new Error('finding resolution already recorded');
  let receipt;
  try { await store.update(unit, async record => {
    const previous = (record.findingResolutions ?? []).find(item => item.id === request.id);
    if (previous) {
      if (previous.requestDigest !== requestDigest) reject('resolution ID already has another payload', 'FINDING_RESOLUTION_CONFLICT');
      receipt = { ...previous, duplicate: true };
      throw duplicate;
    }
    if (record.revision !== request.expectedRevision) reject('resolution revision is stale', 'FINDING_RESOLUTION_STALE');
    if (!['InReview', 'Accepted'].includes(record.state) || ['review', 'ops'].includes(record.kind) || record.accepted) {
      reject('resolution requires an ongoing reviewed implementation before acceptance', 'INVALID_TRANSITION');
    }
    if (hasOpenStage(record)) reject('resolution requires all target stages to be submitted', 'STAGE_ALREADY_OPEN');
    for (const item of request.findings) {
      const finding = record.findings?.[item.index];
      if (!finding || effectArgsDigest(finding) !== item.digest || finding.resolvedAt != null || finding.resolutionRef != null
        || !['review', 'coverage'].includes(finding.kind)
        || !['must-fix', 'should-fix', 'nice'].includes(finding.severity)
        || !['id', 'site', 'claim', 'case', 'fix'].every(key => text(finding[key]))
        || Object.keys(finding).some(key => !['id', 'kind', 'severity', 'site', 'claim', 'case', 'fix', 'acceptanceRef', 'classification', 'resolvedAt'].includes(key))) {
        reject('only exact unresolved reviewer-authored review or coverage findings can be resolved');
      }
    }
    if (typeof adapters.git?.inspectUnit !== 'function') reject('resolution requires Git inspection', 'ADAPTER_MISSING');
    assertSource(record, request, await adapters.git.inspectUnit({ unit, record }));
    await checkReview({ store, stateRoot, record, request, contract, cwd });
    await verifyApprovalInput(adapters.provider, { unit, userInputRef, effect: 'finding.resolve', argsDigest: requestDigest,
      head: request.head, contentFingerprint: request.contentFingerprint, reviewer: request.reviewer, independent: true, reason: request.reason });
    const checkedReview = await checkReview({ store, stateRoot, record, request, contract, cwd });
    assertSource(record, request, await adapters.git.inspectUnit({ unit, record }));
    const resolvedAt = adapters.now();
    receipt = { ...request, unit, requestDigest, userInputRef, resolvedAt, revision: record.revision + 1,
      ...(checkedReview.recovered ? { previousReview: { verdict: record.verdict, reviewedHead: record.reviewedHead, reviewDecision: record.reviewDecision } } : {}) };
    const indexes = new Set(request.findings.map(item => item.index));
    return { ...record, ...(checkedReview.recovered ? { verdict: 'ship', reviewedHead: request.head,
      reviewDecision: { ...record.reviewDecision, submissionId: checkedReview.output.submissionId } } : {}),
      findings: record.findings.map((finding, index) => indexes.has(index)
      ? { ...finding, resolvedAt, resolutionRef: request.id } : finding),
      findingResolutions: [...(record.findingResolutions ?? []), receipt] };
  }); } catch (error) { if (error !== duplicate) throw error; }
  return receipt;
}
