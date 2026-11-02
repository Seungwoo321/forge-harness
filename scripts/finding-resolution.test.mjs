import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { effectArgsDigest } from './lib/approvals.mjs';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const finding = (id, kind = 'review') => ({ id, kind, severity: 'must-fix', site: 'app.txt',
  claim: 'Output is incorrect', case: 'Boundary input produces wrong output', fix: 'Correct output and verify boundary',
  classification: 'harness', resolvedAt: null });

async function fixture(t, { separate = false, extraFindings = [], goalClass = 'task', legacyCli, outside = false } = {}) {
  let executable = legacyCli ?? cli;
  const filesRoot = await mkdtemp(path.join(os.tmpdir(), 'finding-resolution-'));
  const cwd = path.join(filesRoot, 'product');
  await mkdir(cwd);
  t.after(() => rm(filesRoot, { recursive: true, force: true }));
  const git = (...args) => {
    const child = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'app.txt'), 'baseline'); git('add', '.'); git('commit', '-qm', 'baseline');
  const provider = path.join(filesRoot, 'runtime.mjs');
  const approvalFile = path.join(filesRoot, 'authorization.json');
  await writeFile(provider, `
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
export function createRuntimeAdapters({ cwd, adapters }) {
  const files = async () => [{ path: 'app.txt', content: await readFile(path.join(cwd, 'app.txt'), 'utf8') }];
  return {
    provider: { async verifyUserInput(input) {
      const auth = JSON.parse(await readFile(${JSON.stringify(approvalFile)}, 'utf8'));
      const verified = (Array.isArray(auth.input) ? auth.input : [auth.input]).some(item => isDeepStrictEqual(input, item))
        && input.reviewer === 'independent-reviewer' && input.independent === true && (await files())[0].content === 'fixed';
      if (auth.mutate === 'source') await writeFile(path.join(cwd, 'app.txt'), 'drift');
      if (auth.mutate === 'evidence') await writeFile(auth.evidencePath, 'changed');
      if (auth.mutate === 'output') await writeFile(auth.outputPath, '{}');
      return { ...input, verified };
    } },
    git: { async inspectUnit() { return { head: (await adapters.command('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(),
      contentFingerprint: createHash('sha256').update(JSON.stringify(await files())).digest('hex') }; } },
    gates: {
      async describe(id) { return { id, command: ['test', id], format: 'exec', files: await files() }; },
      async run(gate) { const ok = ['broken', 'fixed'].includes((await files())[0].content);
        return { exit: ok ? 0 : 1, ok, covers: ['AC-1'], report: '{}', reportPath: gate.id+'.json' }; },
    },
  };
}
`);
  const unit = 'change-a';
  const root = path.join(cwd, '.git/work-state');
  const read = async file => JSON.parse(await readFile(file, 'utf8'));
  const record = (name = unit) => read(path.join(root, 'units', name, 'unit.json'));
  const parse = child => { const result = JSON.parse(child.stdout.trim().split('\n').at(-1).slice(7));
    assert.equal(child.status, result.code, child.stderr); return result; };
  const run = (args, withProvider = true) => parse(spawnSync(process.execPath,
    [executable, ...args, ...(withProvider ? ['--adapters', typeof withProvider === 'string' ? withProvider : provider] : [])], { cwd, encoding: 'utf8' }));
  const start = async (name = unit, kind = 'impl') => {
    const file = path.join(filesRoot, name+'-request.json');
    await writeFile(file, JSON.stringify({ kind, ...(kind === 'review' ? { targetUnit: unit } : {}),
      request: { text: 'Correct output', userInputRef: 'request-1' },
      policyOverrides: { goal: { class: goalClass }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] } } }));
    assert.equal(run(['unit', 'start', name, '--request', file, '--non-interactive']).code, 0);
  };
  const open = (stage, name = unit) => run(['unit', 'stage', 'open', name, stage]);
  const submit = async (stage, fields, name = unit) => {
    const attempt = (await record(name)).stages.find(item => item.name === stage).attempts.at(-1);
    const input = await read(path.join(root, 'units', name, attempt.inputPath));
    const outputPath = path.join(filesRoot, name+'-'+stage+'-'+attempt.n+'.json');
    await writeFile(outputPath, JSON.stringify({ inputDigest: input.inputDigest, attempt: attempt.n,
      submissionId: name+'-'+stage+'-'+attempt.n, status: 'done', summary: stage+' done',
      ...(stage === 'review' ? { reviewedHead: input.head } : {}), ...fields }));
    const result = run(['unit', 'stage', 'submit', name, stage, '--output', outputPath]);
    assert.equal(result.code, 0, JSON.stringify(result)); return outputPath;
  };
  const implement = async value => {
    assert.equal(open('implement').code, 0);
    await writeFile(path.join(cwd, 'app.txt'), value);
    if (outside) await writeFile(path.join(cwd, 'outside.txt'), 'outside scope');
    await submit('implement', { changedPaths: ['app.txt'], coverage: [{ acceptanceRef: 'AC-1', evidenceHint: 'boundary test' }], assumptions: [], openDecisions: [] });
  };
  await start(); assert.equal(open('scope').code, 0);
  await submit('scope', { acceptance: [{ id: 'AC-1', text: 'Boundary output is correct' }], scopePaths: ['app.txt'], openDecisions: [] });
  // The initial smoke gate misses the boundary defect found by review.
  await implement('broken');
  assert.equal(run(['unit', 'accept', unit]).code, 20);
  assert.equal(open('review').code, 0);
  await submit('review', { verdict: 'fix', findings: [finding('F-1'), finding('F-2', 'coverage'), ...extraFindings] });
  await implement('fixed');
  assert.equal(run(['unit', 'accept', unit]).code, 20);
  const reviewUnit = separate ? 'review-a' : unit;
  if (separate) await start(reviewUnit, 'review');
  assert.equal(open('review', reviewUnit).code, 0);
  const outputPath = await submit('review', { verdict: 'ship', findings: [] }, reviewUnit);
  // Published acceptance cleared ship; the repaired command preserves it.
  assert.equal(run(['unit', 'accept', unit]).code, legacyCli ? 20 : 1);
  executable = cli;
  const evidencePath = path.join(filesRoot, 'independent-verification.json');
  await writeFile(evidencePath, JSON.stringify({ result: 'passed', reviewer: 'independent-reviewer', fixes: ['F-1', 'F-2'] }));
  const prepare = async (extra = {}, authorized = true, mutate = null) => {
    const current = await record();
    const attempt = (await record(reviewUnit)).stages.find(item => item.name === 'review').attempts.at(-1);
    const request = { id: 'resolution-1', expectedRevision: current.revision,
      head: current.head, contentFingerprint: current.contentFingerprint,
      findings: current.findings.map((item, index) => ({ index, digest: effectArgsDigest(item) })),
      review: { unit: reviewUnit, attempt: attempt.n, outputPath, outputDigest: attempt.outputDigest },
      reviewer: 'independent-reviewer', evidence: { path: evidencePath, digest: bytesDigest(await readFile(evidencePath)) },
      reason: 'Independent boundary checks demonstrate both fixes', ...extra };
    const file = path.join(filesRoot, request.id+'-resolve.json');
    await writeFile(file, JSON.stringify(request));
    await writeFile(approvalFile, JSON.stringify({ input: authorized ? { unit, userInputRef: 'original-authority', effect: 'finding.resolve',
      argsDigest: effectArgsDigest({ request, userInputRef: 'original-authority' }), head: request.head,
      contentFingerprint: request.contentFingerprint, reviewer: request.reviewer, independent: true, reason: request.reason } : {},
    mutate, outputPath, evidencePath }));
    return ['unit', 'finding', 'resolve', unit, '--request', file, '--user-input', 'original-authority'];
  };
  const concurrent = argsList => Promise.all(argsList.map(args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args, '--adapters', provider], { cwd });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', status => {
      try { resolve(parse({ stdout, stderr, status })); } catch (error) { reject(error); }
    });
  })));
  return { cwd, filesRoot, root, unit, read, record, run, prepare, open, start, submit, implement, concurrent, outputPath, reviewUnit, evidencePath, approvalFile, provider };
}

for (const separate of [false, true]) test(`public fix-review-resolve-accept preserves history (${separate ? 'separate' : 'same-unit'} review)`, async t => {
  const f = await fixture(t, { separate });
  const before = await f.record();
  assert.equal(before.verdict, 'ship');
  const args = await f.prepare();
  const result = f.run(args); assert.equal(result.code, 0, JSON.stringify(result));
  const after = await f.record();
  const { revision, findings, findingResolutions, ...unchanged } = after;
  const { revision: oldRevision, findings: oldFindings, ...original } = before;
  assert.deepEqual(unchanged, original); assert.equal(revision, oldRevision + 1);
  assert.deepEqual(findings.map(({ resolvedAt, resolutionRef, ...item }) => ({ ...item, resolvedAt: null })), oldFindings);
  assert.ok(findings.every(item => item.resolvedAt && item.resolutionRef === 'resolution-1'));
  assert.deepEqual(findingResolutions, [result.resolution]);
  assert.equal(f.run(args).resolution.duplicate, true); assert.deepEqual(await f.record(), after);
  assert.equal(f.run(await f.prepare({ reason: 'changed' })).error, 'FINDING_RESOLUTION_CONFLICT');
  assert.deepEqual(await f.record(), after);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
  assert.equal((await f.record()).state, 'Accepted');
  assert.equal(f.run(await f.prepare({ id: 'after-accept' })).error, 'INVALID_TRANSITION');
});

test('unrelated unresolved findings still block; multi-finding validation is atomic', async t => {
  const f = await fixture(t); const before = await f.record();
  const first = { index: 0, digest: effectArgsDigest(before.findings[0]) };
  const bad = await f.prepare({ findings: [first, { index: 1, digest: effectArgsDigest({ wrong: true }) }] });
  assert.equal(f.run(bad).error, 'FINDING_RESOLUTION_INVALID'); assert.deepEqual(await f.record(), before);
  assert.equal(f.run(await f.prepare({ findings: [first] })).code, 0);
  assert.equal((await f.record()).findings[1].resolvedAt, null);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 1);
});

test('malformed, stale, wrong target/source/evidence and unauthorized requests preserve state', async t => {
  const f = await fixture(t); const before = await f.record();
  const first = { index: 0, digest: effectArgsDigest(before.findings[0]) };
  const review = { unit: f.reviewUnit, attempt: 2, outputPath: f.outputPath, outputDigest: effectArgsDigest(await f.read(f.outputPath)) };
  for (const extra of [
    { unknown: true }, { findings: [] }, { findings: [first, first] }, { findings: [{ ...first, unknown: true }] },
    { findings: [{ index: 100, digest: first.digest }] }, { expectedRevision: before.revision - 1 },
    { head: 'wrong' }, { contentFingerprint: 'wrong' }, { reviewer: 'implementation-author' },
    { review: { ...review, unit: 'missing' } }, { review: { ...review, attempt: 1 } },
    { review: { ...review, outputDigest: effectArgsDigest({ wrong: true }) } },
    { evidence: { path: f.evidencePath, digest: effectArgsDigest({ wrong: true }) } },
    { evidence: { path: 'missing', digest: first.digest } },
  ]) {
    const result = f.run(await f.prepare(extra)); assert.notEqual(result.code, 0, JSON.stringify(extra));
    assert.deepEqual(await f.record(), before);
  }
  assert.equal(f.run(await f.prepare({}, false)).error, 'EFFECT_APPROVAL_REQUIRED');
  const noVerifier = path.join(f.filesRoot, 'no-verifier.mjs');
  await writeFile(noVerifier, `import { createRuntimeAdapters as create } from ${JSON.stringify(pathToFileURL(f.provider).href)};
export function createRuntimeAdapters(context) { return { ...create(context), provider: undefined }; }`);
  assert.equal(f.run(await f.prepare(), noVerifier).error, 'EFFECT_APPROVAL_REQUIRED');
  assert.deepEqual(await f.record(), before);
  const wrong = await f.prepare(); wrong[3] = 'another-target';
  assert.equal(f.run(wrong).error, 'UNIT_NOT_FOUND'); assert.deepEqual(await f.record(), before);
  // An invalid target may leave a lock directory, but cannot poison later recovery.
  assert.equal(f.run(await f.prepare()).code, 0);
});

for (const mutate of ['source', 'evidence', 'output']) test(`drift during trusted verification rejects atomically: ${mutate}`, async t => {
  const f = await fixture(t); const before = await f.record();
  assert.equal(f.run(await f.prepare({}, true, mutate)).error,
    mutate === 'source' ? 'FINDING_RESOLUTION_STALE' : 'FINDING_RESOLUTION_INVALID');
  assert.deepEqual(await f.record(), before);
});

test('active stages and unsupported lifecycle reject without mutation', async t => {
  const f = await fixture(t, { separate: true });
  const activeArgs = await f.prepare();
  assert.equal(f.open('review').code, 0);
  const before = await f.record();
  const requestPath = path.join(f.filesRoot, 'resolution-1-resolve.json');
  const request = await f.read(requestPath);
  await writeFile(requestPath, JSON.stringify({ ...request, expectedRevision: before.revision }));
  assert.equal(f.run(activeArgs).error, 'STAGE_ALREADY_OPEN'); assert.deepEqual(await f.record(), before);
  await f.start('another-review', 'review');
  const args = [...activeArgs]; args[3] = 'another-review';
  const reviewBefore = await f.record('another-review');
  await writeFile(requestPath, JSON.stringify({ ...request, expectedRevision: reviewBefore.revision }));
  assert.equal(f.run(args).error, 'INVALID_TRANSITION'); assert.deepEqual(await f.record('another-review'), reviewBefore);
});

test('concurrent exact requests serialize with one receipt and one mutation', async t => {
  const f = await fixture(t); const before = await f.record(); const args = await f.prepare();
  const results = await f.concurrent([args, args]);
  assert.ok(results.every(item => item.code === 0), JSON.stringify(results));
  assert.equal(results.filter(item => item.resolution.duplicate).length, 1);
  assert.equal((await f.record()).revision, before.revision + 1);
  assert.equal((await f.record()).findingResolutions.length, 1);
});

test('scope and shared-path findings retain their own resolution owners', async t => {
  const f = await fixture(t, { extraFindings: [finding('scope', 'scope-guard'), finding('shared', 'shared-path')] });
  const before = await f.record();
  for (const index of [2, 3]) {
    assert.equal(f.run(await f.prepare({ findings: [{ index, digest: effectArgsDigest(before.findings[index]) }] })).error, 'FINDING_RESOLUTION_INVALID');
    assert.deepEqual(await f.record(), before);
  }
});

test('concurrent different resolutions reject stale revision without partial mutation', async t => {
  const f = await fixture(t); const before = await f.record();
  const first = await f.prepare({ id: 'first', findings: [{ index: 0, digest: effectArgsDigest(before.findings[0]) }] });
  const auth = await f.read(f.approvalFile);
  const second = await f.prepare({ id: 'second', findings: [{ index: 1, digest: effectArgsDigest(before.findings[1]) }] });
  const other = await f.read(f.approvalFile);
  await writeFile(f.approvalFile, JSON.stringify({ input: [auth.input, other.input] }));
  const results = await f.concurrent([first, second]);
  assert.equal(results.filter(item => item.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(item => item.error === 'FINDING_RESOLUTION_STALE').length, 1);
  const after = await f.record();
  assert.equal(after.revision, before.revision + 1); assert.equal(after.findingResolutions.length, 1);
  assert.equal(after.findings.filter(item => item.resolvedAt).length, 1);
});

test('prelaunch public scope respects exact paths and real out-of-scope findings remain unresolved', async t => {
  for (const outside of [false, true]) {
    const f = await fixture(t, { separate: true, goalClass: 'product-prelaunch', outside });
    const before = await f.record();
    const generated = before.findings.filter(item => item.kind === 'scope-guard');
    assert.equal(generated.length > 0, outside);
    for (const item of generated) assert.deepEqual(item.paths, ['outside.txt']);
    const checked = f.run(['unit', 'scope', 'recheck', f.unit]);
    assert.equal(checked.code, 0, JSON.stringify(checked));
    assert.deepEqual(checked.recheck.resolved, []);
    assert.deepEqual(await f.record(), before);
    const findings = before.findings.flatMap((item, index) => item.id ? [{ index, digest: effectArgsDigest(item) }] : []);
    assert.equal(f.run(await f.prepare({ findings })).code, 0);
    assert.equal(f.run(['unit', 'accept', f.unit]).code, outside ? 1 : 0);
  }
});

test('published prelaunch findings and cleared ship recover using public commands and original evidence', {
  skip: !process.env.FINDING_RECOVERY_CLI,
}, async t => {
  const f = await fixture(t, { separate: true, goalClass: 'product-prelaunch', legacyCli: process.env.FINDING_RECOVERY_CLI });
  const original = await f.record();
  assert.equal(original.verdict, null);
  assert.ok(original.findings.some(item => item.kind === 'scope-guard'));
  const checked = f.run(['unit', 'scope', 'recheck', f.unit]);
  assert.equal(checked.code, 0, JSON.stringify(checked));
  const before = await f.record();
  assert.equal(checked.recheck.resolved.length, original.findings.filter(item => item.kind === 'scope-guard').length);
  for (const { index, digest } of checked.recheck.resolved) {
    assert.equal(digest, effectArgsDigest(original.findings[index]));
    assert.ok(before.findings[index].resolvedAt);
  }
  assert.deepEqual(f.run(['unit', 'scope', 'recheck', f.unit]).recheck.resolved, []);
  assert.deepEqual(await f.record(), before);
  const findings = before.findings.flatMap((item, index) => item.id ? [{ index, digest: effectArgsDigest(item) }] : []);
  const result = f.run(await f.prepare({ findings }));
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.resolution.previousReview.verdict, null);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
  const after = await f.record();
  for (const key of ['stages', 'evidence', 'failures', 'policy', 'scopePaths']) assert.deepEqual(after[key], original[key]);
  assert.equal(after.state, 'Accepted');
});

test('a subsequent fix and implementation cannot be resolved with an older ship review', async t => {
  const f = await fixture(t, { separate: true });
  await f.start('review-b', 'review');
  assert.equal(f.open('review', 'review-b').code, 0);
  await f.submit('review', { verdict: 'fix', findings: [] }, 'review-b');
  // Even unchanged bytes must receive a fresh review after this repair cycle.
  await f.implement('fixed');
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
  const before = await f.record();
  assert.equal(f.run(await f.prepare()).error, 'FINDING_RESOLUTION_STALE');
  assert.deepEqual(await f.record(), before);
});
