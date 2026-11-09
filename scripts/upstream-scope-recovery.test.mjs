import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters } from './lib/adapters.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';

async function fixture(t, { overlap = false, outside = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstream-scope-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  for (const file of ['source', 'upstream', 'shared']) await writeFile(path.join(cwd, file), 'baseline\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const originalHead = git('rev-parse', 'HEAD'), branch = git('branch', '--show-current');
  const stateRoot = path.join(cwd, '.git/work-state'), store = createUnitStateStore(stateRoot);
  const core = createAdapters({ repositoryRoot: cwd });
  const observe = async () => {
    const head = git('rev-parse', 'HEAD'), base = git('merge-base', head, 'refs/heads/upstream-base');
    const snapshot = await core.checkpoint.inspectChanges({ checkpoint: base, firstCheckpoint: base, head });
    return { head, contentFingerprint: `git-tree:${snapshot.tree}`, tree: snapshot.tree,
      repo: cwd, branch, base, baseRef: 'refs/heads/upstream-base', changedPaths: snapshot.firstCheckpointDiff };
  };
  git('branch', 'upstream-base');
  const adapters = { ...core, git: { inspectUnit: observe }, gates: { describe: async id => ({ id,
    command: [process.execPath, '-e', 'console.log(JSON.stringify({ok:true,covers:["AC-1"]}))'],
    format: 'exec', resultFormat: 'json', files: [{ path: 'source', content: await readFile(path.join(cwd, 'source'), 'utf8') }] }) } };
  let runner = process.env.UPSTREAM_SCOPE_LEGACY_ROOT
    ? (await import(pathToFileURL(path.join(process.env.UPSTREAM_SCOPE_LEGACY_ROOT, 'scripts/lib/unit-driver.mjs')))).runUnitCli : runUnitCli;
  const call = async (args, overrides = {}) => {
    const output = await runner(args, { cwd, stateRoot, adapters: { ...adapters, ...overrides } });
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
  };
  const requestFile = path.join(cwd, '.git/request.json');
  const request = async (args, body, overrides) => { await writeFile(requestFile, JSON.stringify(body)); return call([...args, '--request', requestFile], overrides); };
  const start = async (unit, kind = 'impl') => {
    const result = await request(['unit', 'start', unit, '--non-interactive'], { kind,
      ...(kind === 'review' ? { targetUnit: 'demo' } : {}), request: { text: 'Correct source', userInputRef: 'approved-input' },
      policyOverrides: { goal: { class: 'task' }, delivery: 'none', review: { mode: 'required', by: 'session', triggers: [] } } });
    assert.equal(result.code, 0, JSON.stringify(result));
  };
  const open = async (unit, stage) => { const r = await call(['unit', 'stage', 'open', unit, stage]); assert.equal(r.code, 0, JSON.stringify(r)); return JSON.parse(await readFile(r.input, 'utf8')); };
  const submit = async (unit, stage, input, fields) => {
    const output = path.join(cwd, '.git', `${unit}-${stage}-${input.attempt}.json`);
    await writeFile(output, JSON.stringify({ inputDigest: input.inputDigest, attempt: input.attempt,
      submissionId: `${unit}-${stage}-${input.attempt}`, status: 'done', summary: `${stage} completed`,
      ...(stage === 'review' ? {} : { assumptions: [], openDecisions: [] }), ...fields }));
    const result = await call(['unit', 'stage', 'submit', unit, stage, '--output', output]);
    assert.equal(result.code, 0, JSON.stringify(result)); return output;
  };
  await start('demo');
  const scoped = await open('demo', 'scope');
  await submit('demo', 'scope', scoped, { acceptance: [{ id: 'AC-1', text: 'Source output is correct' }], scopePaths: ['source'] });
  const first = await open('demo', 'implement');
  await writeFile(path.join(cwd, 'source'), 'unit change\n');
  if (overlap) await writeFile(path.join(cwd, 'shared'), 'unit overlap\n');
  await submit('demo', 'implement', first, { changedPaths: ['source'], coverage: [{ acceptanceRef: 'AC-1', evidenceHint: 'source test' }] });
  git('add', '.'); git('commit', '-qm', 'unit implementation');
  assert.equal((await call(['unit', 'accept', 'demo'])).code, 20);
  const reviewed = await open('demo', 'review');
  await submit('demo', 'review', reviewed, { reviewedHead: reviewed.head, verdict: 'ship', findings: [] });
  const accepted = await store.read('demo');
  assert.equal((await request(['unit', 'reopen', 'demo'], { expectedRevision: accepted.revision, reason: 'integrate approved base', evidence: 'approved-base-reference' })).code, 0);
  git('checkout', '-q', 'upstream-base');
  await writeFile(path.join(cwd, 'upstream'), 'approved upstream\n');
  if (overlap) await writeFile(path.join(cwd, 'shared'), 'upstream overlap\n');
  git('add', '.'); git('commit', '-qm', 'upstream integration');
  const base = git('rev-parse', 'HEAD'); git('checkout', '-q', branch);
  if (overlap) {
    try { git('merge', '--no-ff', '-m', 'integrate approved base', 'upstream-base'); } catch {
      await writeFile(path.join(cwd, 'shared'), 'upstream overlap\n'); git('add', 'shared'); git('commit', '-qm', 'resolve overlap to upstream');
    }
  } else git('merge', '--no-ff', '-qm', 'integrate approved base', 'upstream-base');
  const currentHead = git('rev-parse', 'HEAD');
  const prior = (await store.read('demo')).stages.find(s => s.name === 'implement').attempts.at(-1);
  assert.equal((await request(['unit', 'stage', 'restart', 'demo', 'implement'], {
    attempt: prior.n, inputDigest: prior.inputDigest, checkpointHead: prior.checkpointHead, newHead: currentHead })).code, 0);
  const reopened = await open('demo', 'implement');
  if (outside) await writeFile(path.join(cwd, 'outside'), 'actual drift\n');
  await submit('demo', 'implement', reopened, { changedPaths: [], coverage: [{ acceptanceRef: 'AC-1', evidenceHint: 'source test' }] });
  const initialAcceptance = await call(['unit', 'accept', 'demo']);
  assert.ok([1, 20].includes(initialAcceptance.code), JSON.stringify(initialAcceptance));
  await start('review-current', 'review');
  const currentReview = await open('review-current', 'review');
  await submit('review-current', 'review', currentReview, { reviewedHead: currentReview.head, verdict: 'ship', findings: [] });
  assert.equal((await call(['unit', 'accept', 'demo'])).code, 1);
  const before = await store.read('demo');
  assert.ok(before.findings.some(f => f.kind === 'scope-guard' && f.paths.includes('upstream')));
  assert.deepEqual((await call(['unit', 'scope', 'recheck', 'demo'], { git: undefined })).recheck.resolved, []);
  runner = runUnitCli;
  return { cwd, git, core, adapters, call, store, before, base, currentHead, originalHead, observe };
}

test('public same-unit recheck resolves upstream-only historical findings and preserves current review and gate evidence', async t => {
  const f = await fixture(t);
  const result = await f.call(['unit', 'scope', 'recheck', 'demo']);
  assert.equal(result.code, 0, JSON.stringify(result)); assert.ok(result.recheck.resolved.length);
  const checked = await f.store.read('demo');
  for (const key of ['scopePaths', 'stages', 'changedPaths', 'evidence', 'failures', 'reviewDecision', 'verdict', 'head', 'contentFingerprint', 'diff', 'handoff']) assert.deepEqual(checked[key], f.before[key], key);
  for (const row of result.recheck.resolved) {
    assert.deepEqual(row.finding, f.before.findings[row.index]); assert.equal(row.digest, effectArgsDigest(row.finding));
    assert.equal(checked.findings[row.index].resolutionRef, result.recheck.id);
  }
  assert.equal(result.recheck.attribution.base, f.base);
  assert.deepEqual(result.recheck.attribution.changedPaths, ['source']);
  assert.deepEqual((await f.call(['unit', 'scope', 'recheck', 'demo'])).recheck.resolved, []);
  assert.deepEqual(await f.store.read('demo'), checked);
  assert.equal((await f.call(['unit', 'accept', 'demo'])).code, 0);
  assert.deepEqual((await f.store.read('demo')).evidence, f.before.evidence);
});

test('actual unit drift and upstream/unit overlap remain unresolved, including overlap resolved to upstream bytes', async t => {
  for (const options of [{ outside: true }, { overlap: true }]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options), result = await f.call(['unit', 'scope', 'recheck', 'demo']);
    assert.equal(result.code, 0, JSON.stringify(result)); assert.deepEqual(result.recheck.resolved, []);
    assert.deepEqual(await f.store.read('demo'), f.before);
    assert.equal((await f.call(['unit', 'accept', 'demo'])).code, 1);
  });
});

test('forged base, non-ancestor, root, branch, diff and stale evidence are rejected atomically', async t => {
  const f = await fixture(t), current = await f.observe();
  for (const forged of [{ base: f.originalHead }, { base: 'f'.repeat(40) }, { repo: os.tmpdir() }, { branch: 'another-branch' },
    { head: f.originalHead }, { contentFingerprint: 'stale' }, { changedPaths: [] }, { baseRef: `refs/heads/${current.branch}` }]) {
    const result = await f.call(['unit', 'scope', 'recheck', 'demo'], { git: { inspectUnit: async () => ({ ...current, ...forged }) } });
    assert.notEqual(result.code, 0, JSON.stringify(forged)); assert.deepEqual(await f.store.read('demo'), f.before);
  }
  let observations = 0;
  const stale = await f.call(['unit', 'scope', 'recheck', 'demo'], { git: { inspectUnit: async () => {
    if (++observations === 2) await writeFile(path.join(f.cwd, 'source'), 'concurrent change\n');
    return f.observe();
  } } });
  assert.equal(stale.error, 'STAGE_STALE'); assert.deepEqual(await f.store.read('demo'), f.before);
});

test('HEAD, branch and base locks protect scope recheck and prevent concurrent Git writes', async t => {
  const f = await fixture(t);
  for (const name of ['HEAD', `refs/heads/${f.git('branch', '--show-current')}`, 'refs/heads/upstream-base']) {
    const lock = path.join(f.cwd, '.git', `${name}.lock`); await writeFile(lock, 'held');
    const r = await f.call(['unit', 'scope', 'recheck', 'demo']); assert.notEqual(r.code, 0);
    assert.equal(await readFile(lock, 'utf8'), 'held'); assert.deepEqual(await f.store.read('demo'), f.before); await rm(lock);
  }
  const blocked = new Set();
  const result = await f.call(['unit', 'scope', 'recheck', 'demo'], { command: async (binary, args, options) => {
    if (args[0] === 'merge-base' && args[1] === '--all') for (const ref of ['HEAD', 'refs/heads/upstream-base']) {
      const write = await f.core.command('git', ['update-ref', ref, f.originalHead], { cwd: f.cwd });
      if (write.exitCode !== 0) blocked.add(ref);
    }
    return f.core.command(binary, args, options);
  } });
  assert.equal(result.code, 0, JSON.stringify(result)); assert.deepEqual([...blocked].sort(), ['HEAD', 'refs/heads/upstream-base']);
  assert.equal(f.git('rev-parse', 'HEAD'), f.currentHead); assert.equal(f.git('rev-parse', 'upstream-base'), f.base);
});
