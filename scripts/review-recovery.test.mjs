import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAdapters } from './lib/adapters.mjs';
import { createStageInput } from './lib/stage-contract.mjs';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function fixture(t, initialCli = cli) {
  let executable = initialCli;
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product');
  await mkdir(cwd);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'main.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const providers = path.join(root, 'providers.mjs');
  await writeFile(providers, `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export function createRuntimeAdapters({ cwd, adapters }) {
  return {
    git: { async inspectUnit() { if (process.env.TEST_EMPTY_INSPECTION) return null; return {
      head: (await adapters.command('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(),
      contentFingerprint: createHash('sha256').update(await readFile(path.join(cwd, 'main.txt'))).digest('hex'),
    }; } },
    gates: {
      async describe(id) { return { id, command: ['test', id], format: 'exec',
        files: [{ path: 'main.txt', content: await readFile(path.join(cwd, 'main.txt'), 'utf8') }] }; },
      async run(gate) { return { exit: 0, ok: true, covers: ['AC-1'], report: '{}', reportPath: gate.id+'.json' }; },
    },
  };
}
`);
  const unit = 'change-a';
  const stateRoot = path.join(cwd, '.git', 'work-state');
  const unitDir = path.join(stateRoot, 'units', unit);
  const read = async file => JSON.parse(await readFile(file, 'utf8'));
  const record = () => read(path.join(unitDir, 'unit.json'));
  const run = (args, env = {}) => {
    const child = spawnSync(process.execPath, [executable, ...args, '--adapters', providers], {
      cwd, encoding: 'utf8', env: { ...process.env, ...env },
    });
    const line = child.stdout.trim().split('\n').at(-1);
    assert.match(line ?? '', /^RESULT /, child.stderr);
    const output = JSON.parse(line.slice(7));
    assert.equal(child.status, output.code);
    return output;
  };
  const submit = async (stage, fields, reviewer = unit, env = {}) => {
    const input = await read(path.join(stateRoot, 'units', reviewer, 'stages', `${stage}.1.input.json`));
    const output = path.join(root, `${reviewer}-${stage}-output.json`);
    await writeFile(output, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt,
      submissionId: `${reviewer}-${stage}`, status: 'done', summary: `${stage} completed`, ...fields }));
    return run(['unit', 'stage', 'submit', reviewer, stage, '--output', output], env);
  };
  const start = async (name = unit, kind = 'impl') => {
    const request = path.join(root, `${name}-request.json`);
    await writeFile(request, JSON.stringify({ kind, ...(kind === 'review' ? { targetUnit: unit } : {}),
      request: { text: 'Change the documented behavior', userInputRef: 'request-1' },
      policyOverrides: { goal: { class: 'task' }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] } } }));
    const result = run(['unit', 'start', name, '--request', request, '--non-interactive']);
    assert.equal(result.code, 0, JSON.stringify(result));
  };
  const implemented = async () => {
    await start();
    assert.equal(run(['unit', 'stage', 'open', unit, 'scope']).code, 0);
    assert.equal((await submit('scope', { acceptance: [{ id: 'AC-1', text: 'Changed behavior is verified' }],
      scopePaths: ['main.txt'], openDecisions: [] })).code, 0);
    assert.equal(run(['unit', 'stage', 'open', unit, 'implement']).code, 0);
    await writeFile(path.join(cwd, 'main.txt'), 'after\n');
    assert.equal((await submit('implement', { changedPaths: ['main.txt'],
      coverage: [{ acceptanceRef: 'AC-1', evidenceHint: 'verified behavior' }], assumptions: [], openDecisions: [] })).code, 0);
    const accepted = run(['unit', 'accept', unit]);
    assert.equal(accepted.code, 20, JSON.stringify(accepted));
  };
  return { root, cwd, git, unit, unitDir, read, record, run, submit, start, implemented,
    upgrade() { executable = cli; } };
}

test('public unseeded lifecycle prepares real review diff and handoff and binds the live target', async t => {
  const f = await fixture(t);
  await f.implemented();
  const before = await f.record();
  assert.equal(before.diff, null);
  const opened = f.run(['unit', 'stage', 'open', f.unit, 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = await f.read(opened.input);
  const diffBytes = await readFile(input.data.diff.path);
  assert.equal(hash(diffBytes), input.data.diff.digest);
  const diff = JSON.parse(diffBytes);
  assert.match(diff.patch, /-before\n\+after/);
  assert.deepEqual(diff.paths, ['main.txt']);
  assert.deepEqual(input.data.handoff.evidence, before.evidence);
  assert.equal(input.data.handoff.implementation[0].summary, 'implement completed');
  assert.deepEqual(input.data.acceptance, before.acceptance);
  await writeFile(path.join(f.cwd, 'main.txt'), 'changed after review opened\n');
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head })).error, 'STAGE_STALE');
  await writeFile(path.join(f.cwd, 'main.txt'), 'after\n');
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head })).code, 0);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
  assert.equal((await f.record()).accepted.basis, 'review');
});

for (const change of ['head', 'content']) test(`InReview revalidation refreshes changed ${change} and rejects the old review input`, async t => {
  const f = await fixture(t);
  await f.implemented();
  const opened = f.run(['unit', 'stage', 'open', f.unit, 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = await f.read(opened.input);
  const before = await f.record();
  const refs = f.git('show-ref');
  if (change === 'head') f.git('commit', '--allow-empty', '-qm', 'advance target');
  else await writeFile(path.join(f.cwd, 'main.txt'), 'updated target\n');

  assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
  const refreshed = await f.record();
  assert.equal(refreshed.head, f.git('rev-parse', 'HEAD'));
  assert.equal(refreshed.contentFingerprint, createHash('sha256').update(await readFile(path.join(f.cwd, 'main.txt'))).digest('hex'));
  assert.equal(refreshed.reviewDecision.head, refreshed.head);
  assert.equal(refreshed.reviewDecision.contentFingerprint, refreshed.contentFingerprint);
  assert.equal(refreshed.diff, null);
  assert.equal(refreshed.handoff, null);
  assert.deepEqual(refreshed.stages, before.stages);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head })).error, 'STAGE_STALE');
  assert.deepEqual(await f.record(), refreshed);
  assert.equal(f.git('show-ref', '--', `refs/harness/${f.unit}/review.1`), refs.split('\n').find(line => line.endsWith(`refs/harness/${f.unit}/review.1`)));
  assert.deepEqual(await f.read(opened.input), input);

  await f.start('review-current', 'review');
  const current = f.run(['unit', 'stage', 'open', 'review-current', 'review']);
  assert.equal(current.code, 0, JSON.stringify(current));
  const currentInput = await f.read(current.input);
  assert.equal(currentInput.head, refreshed.head);
  assert.equal(currentInput.contentFingerprint, refreshed.contentFingerprint);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: refreshed.head }, 'review-current')).code, 0);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
});

test('unchanged InReview revalidation preserves prepared review context, evidence and checkpoint', async t => {
  const f = await fixture(t);
  await f.implemented();
  const opened = f.run(['unit', 'stage', 'open', f.unit, 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const before = await f.record();
  const refs = f.git('show-ref');
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
  const after = await f.record();
  for (const field of ['head', 'contentFingerprint', 'reviewDecision', 'diff', 'handoff', 'evidence', 'stages']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(f.git('show-ref'), refs);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: before.head })).code, 0);
});

test('fresh review units prepare target inputs through the same public path', async t => {
  const f = await fixture(t);
  await f.implemented();
  await f.start('review-a', 'review');
  const opened = f.run(['unit', 'stage', 'open', 'review-a', 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = await f.read(opened.input);
  assert.equal(input.targetUnit, f.unit);
  assert.match((await f.read(input.data.diff.path)).patch, /\+after/);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head }, 'review-a')).code, 0);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
});

async function legacyFailure(f, { foreign = false } = {}) {
  const record = await f.record();
  // Reproduce the previous producer ordering: create the unbound ref, then fail the original contract.
  const checkpoint = await createAdapters({ repositoryRoot: f.cwd }).checkpoint.createCheckpoint({
    ref: `refs/harness/${f.unit}/review.1`, head: record.head, exclude: record.policy.checkpoint?.exclude ?? [],
  });
  // The legacy acceptance writer kept this binding only in reviewDecision and discarded implement summaries.
  const legacyRecord = structuredClone(record);
  delete legacyRecord.head;
  delete legacyRecord.contentFingerprint;
  for (const stage of legacyRecord.stages) for (const attempt of stage.attempts) delete attempt.summary;
  await writeFile(path.join(f.unitDir, 'unit.json'), JSON.stringify(legacyRecord));
  const contract = JSON.parse(await readFile(new URL('../skills/review/contract.json', import.meta.url), 'utf8'));
  const data = Object.fromEntries(contract.reads.filter(key => record[key] != null).map(key => [key, record[key]]));
  const failed = createStageInput(contract, { unit: f.unit, targetUnit: f.unit, stage: 'review', attempt: 1,
    inputRevision: record.revision, inputDigest: 'legacy', head: record.head, contentFingerprint: record.contentFingerprint, data },
  { upstreamWriters: Object.fromEntries(contract.reads.map(key => [key, ['control-plane']])), preparedValues: data });
  assert.equal(failed.ok, false);
  assert.equal((await f.record()).revision, record.revision);
  if (foreign) {
    const tree = f.git('rev-parse', `${checkpoint.ref}^{tree}`);
    const other = f.git('commit-tree', tree, '-p', record.head, '-m', `Checkpoint ${checkpoint.ref}`);
    f.git('update-ref', checkpoint.ref, other, checkpoint.commit);
    return other;
  }
  return checkpoint.commit;
}

test('legacy failed review.1 restarts without replacing its ref, unit, evidence or budgets', async t => {
  const f = await fixture(t);
  await f.implemented();
  const commit = await legacyFailure(f);
  const before = await f.record();
  const opened = f.run(['unit', 'stage', 'open', f.unit, 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  assert.equal(opened.attempt, 1);
  assert.equal(f.git('rev-parse', opened.checkpoint), commit);
  const after = await f.record();
  assert.equal(after.head, before.reviewDecision.head);
  assert.equal(after.contentFingerprint, before.reviewDecision.contentFingerprint);
  for (const key of ['unit', 'accepted', 'acceptance', 'evidence', 'failures', 'policy', 'reviewDecision']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.stages.slice(0, 2), before.stages);
});

test('legacy recovery rejects changed head, tree and foreign provenance without rewriting refs', async t => {
  for (const mode of ['head', 'tree', 'foreign']) {
    const f = await fixture(t);
    await f.implemented();
    const commit = await legacyFailure(f, { foreign: mode === 'foreign' });
    if (mode === 'tree') await writeFile(path.join(f.cwd, 'main.txt'), 'drift\n');
    if (mode === 'head') f.git('commit', '--allow-empty', '-qm', 'new head');
    const before = await f.record();
    const rejected = f.run(['unit', 'stage', 'open', f.unit, 'review']);
    assert.notEqual(rejected.code, 0, mode);
    assert.ok(['STAGE_STALE', 'CHECKPOINT_CONFLICT'].includes(rejected.error), JSON.stringify(rejected));
    assert.equal(f.git('rev-parse', `refs/harness/${f.unit}/review.1`), commit);
    assert.deepEqual(await f.record(), before);
  }
});

async function interruptAfterRef(f) {
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const marker = path.join(f.root, 'interrupted');
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (args[0] === 'update-ref' && result.status === 0 && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, 'interrupted'); process.exit(1);
}
process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);
  const failed = f.run(['unit', 'stage', 'open', f.unit, 'review'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(failed.error, 'ADAPTER_GIT_FAILED', JSON.stringify(failed));
  return f.git('rev-parse', `refs/harness/${f.unit}/review.1`);
}

test('public interrupted open reuses the input-bound ref and rejects pending input drift', async t => {
  for (const mode of ['restart', 'input', 'record', 'tree', 'diff-format']) {
    const f = await fixture(t);
    await f.implemented();
    const before = await f.record();
    const commit = await interruptAfterRef(f);
    assert.deepEqual(await f.record(), before);
    const inputFile = path.join(f.unitDir, 'stages', 'review.1.input.json');
    if (mode === 'input') {
      const input = await f.read(inputFile);
      input.data.acceptance[0].text = 'changed';
      await writeFile(inputFile, JSON.stringify(input));
    }
    if (mode === 'diff-format') {
      const input = await f.read(inputFile);
      await writeFile(input.data.diff.path, JSON.stringify(await f.read(input.data.diff.path)));
    }
    if (mode === 'record') assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
    if (mode === 'tree') await writeFile(path.join(f.cwd, 'main.txt'), 'drift\n');
    const opened = f.run(['unit', 'stage', 'open', f.unit, 'review']);
    assert.equal(opened.code === 0, mode === 'restart', JSON.stringify(opened));
    assert.equal(f.git('rev-parse', `refs/harness/${f.unit}/review.1`), commit);
    if (mode === 'restart') {
      assert.equal(opened.attempt, 1);
      assert.equal((await f.record()).stages.at(-1).attempts[0].checkpointCommit, commit);
    }
  }
});

test('invalid stage input creates no checkpoint', async t => {
  const f = await fixture(t);
  await f.start();
  // A scope contract cannot read a verdict before its writer; use the public CLI with the normal unprepared scope input.
  const contracts = path.join(f.root, 'contracts');
  await mkdir(path.join(contracts, 'scope'), { recursive: true });
  const contract = JSON.parse(await readFile(new URL('../skills/scope/contract.json', import.meta.url), 'utf8'));
  contract.reads.push('verdict');
  contract.input.properties.data.required.push('verdict');
  contract.input.properties.data.properties.verdict = { type: 'string' };
  // The driver API supplies contract roots; its external adapters are the same ones as the CLI.
  const { runUnitCli } = await import('./lib/unit-driver.mjs');
  const { cp } = await import('node:fs/promises');
  await cp(new URL('../skills/', import.meta.url), contracts, { recursive: true });
  await writeFile(path.join(contracts, 'scope', 'contract.json'), JSON.stringify(contract));
  const result = await runUnitCli(['unit', 'stage', 'open', f.unit, 'scope'], {
    cwd: f.cwd, contractsDir: contracts, adapters: createAdapters({ repositoryRoot: f.cwd }),
  });
  assert.match(result, /STAGE_CONTRACT_INVALID/);
  assert.equal(f.git('for-each-ref', 'refs/harness'), '');
});

test('input-bound checkpoint reuse requires the exact input digest and filtered tree', async t => {
  const f = await fixture(t);
  const adapter = createAdapters({ repositoryRoot: f.cwd }).checkpoint;
  const request = { ref: 'refs/harness/change-a/implement.1', inputDigest: 'sha256:input-1' };
  const first = await adapter.createCheckpoint(request);
  assert.equal((await adapter.createCheckpoint(request)).commit, first.commit);
  await assert.rejects(adapter.createCheckpoint({ ...request, inputDigest: 'sha256:other' }), { code: 'CHECKPOINT_CONFLICT' });
  await writeFile(path.join(f.cwd, 'main.txt'), 'changed\n');
  await assert.rejects(adapter.createCheckpoint(request), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(f.git('rev-parse', request.ref), first.commit);
});

for (const recovery of ['review-open', 'accept']) test(`published legacy lifecycle recovers through ${recovery} without rewriting records`, {
  skip: !process.env.FORGE_LEGACY_CLI,
}, async t => {
  const f = await fixture(t, process.env.FORGE_LEGACY_CLI);
  await f.implemented();
  await f.start('review-a', 'review');
  assert.equal(f.run(['unit', 'stage', 'open', 'review-a', 'review']).error, 'REVIEW_TARGET_INVALID');
  const before = await f.record();
  assert.equal(before.head, undefined);
  f.upgrade();
  if (recovery === 'accept') {
    assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
    const refreshed = await f.record();
    assert.equal(refreshed.head, before.reviewDecision.head);
    assert.equal(refreshed.contentFingerprint, before.reviewDecision.contentFingerprint);
    assert.deepEqual(refreshed.evidence, before.evidence);
  }
  const opened = f.run(['unit', 'stage', 'open', 'review-a', 'review']);
  assert.equal(opened.code, 0, JSON.stringify(opened));
  const input = await f.read(opened.input);
  assert.match((await f.read(input.data.diff.path)).patch, /-before\n\+after/);
  assert.equal(input.data.handoff.implementation[0].summary, null);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head }, 'review-a')).code, 0);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
  const after = await f.record();
  assert.deepEqual(after.evidence, before.evidence);
  assert.deepEqual(after.acceptance, before.acceptance);
  assert.deepEqual(after.policy, before.policy);
  assert.equal(after.accepted.basis, 'review');
});

test('review submission rejects missing live Git inspection without recording ship', async t => {
  const f = await fixture(t);
  await f.implemented();
  await f.start('review-a', 'review');
  const opened = f.run(['unit', 'stage', 'open', 'review-a', 'review']);
  assert.equal(opened.code, 0);
  const input = await f.read(opened.input);
  const before = await f.record();
  const rejected = await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head },
    'review-a', { TEST_EMPTY_INSPECTION: '1' });
  assert.equal(rejected.error, 'STAGE_STALE');
  assert.deepEqual(await f.record(), before);
});

test('repeated acceptance cannot rebind a prior ship verdict to changed content at the same head', async t => {
  const f = await fixture(t);
  await f.implemented();
  await f.start('review-a', 'review');
  const first = f.run(['unit', 'stage', 'open', 'review-a', 'review']);
  assert.equal(first.code, 0);
  const input = await f.read(first.input);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: input.head }, 'review-a')).code, 0);
  await writeFile(path.join(f.cwd, 'main.txt'), 'changed after ship\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(f.run(['unit', 'accept', f.unit]).code, 20);
    const pending = await f.record();
    assert.equal(pending.state, 'InReview');
    assert.equal(pending.reviewedHead, null);
    assert.equal(pending.verdict, null);
    assert.equal(pending.accepted, null);
  }
  await f.start('review-b', 'review');
  const second = f.run(['unit', 'stage', 'open', 'review-b', 'review']);
  assert.equal(second.code, 0);
  const fresh = await f.read(second.input);
  assert.notEqual(fresh.contentFingerprint, input.contentFingerprint);
  assert.equal((await f.submit('review', { findings: [], verdict: 'ship', reviewedHead: fresh.head }, 'review-b')).code, 0);
  assert.equal(f.run(['unit', 'accept', f.unit]).code, 0);
});
