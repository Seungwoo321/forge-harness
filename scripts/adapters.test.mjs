import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdapters } from './lib/adapters.mjs';

test('external command, clock, and id providers can be replaced deterministically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-adapter-'));
  try {
    const stub = join(dir, 'stub.mjs');
    await writeFile(stub, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    const adapters = createAdapters({
      clock: () => new Date('2026-10-28T00:00:00.000Z'),
      id: () => 'unit-test-id',
    });
    const first = await adapters.command(process.execPath, [stub, 'git', 'status'], { cwd: dir });
    const second = await adapters.command(process.execPath, [stub, 'git', 'status'], { cwd: dir });

    assert.deepEqual(first, { stdout: '["git","status"]', stderr: '', exitCode: 0, signal: null });
    assert.deepEqual(second, first);
    assert.equal(adapters.now(), '2026-10-28T00:00:00.000Z');
    assert.equal(adapters.id(), 'unit-test-id');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('external command contracts reject malformed command and arguments', () => {
  const adapters = createAdapters();
  assert.throws(() => adapters.command('git', 'status'), /string argument list/);
  assert.throws(() => adapters.command('', []), /binary/);
});

test('session runner registration exposes the generic contract and rejects unsupported runners before use', async () => {
  const calls = [];
  const sessionRunner = {
    contractVersion: 'harness.session-adapter/1',
    capabilities: ['fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review'],
    async observe(input) { calls.push(['observe', input]); return { sessionId: 'parent', cwd: input.cwd }; },
    async execute(input) { calls.push(['execute', input]); return { sessionId: 'child' }; },
    async verify(input) { calls.push(['verify', input]); return { status: 'unknown' }; },
  };
  const adapters = createAdapters({ sessionRunner });
  assert.equal(adapters.session.contractVersion, 'harness.session-adapter/1');
  assert.deepEqual(await adapters.session.observe({ cwd: '/work' }), { sessionId: 'parent', cwd: '/work' });
  assert.deepEqual(await adapters.session.execute({ args: { unit: 'next' } }), { sessionId: 'child' });
  assert.deepEqual(await adapters.session.verify({ effect: 'session.start' }), { status: 'unknown' });
  assert.deepEqual(calls.map(([name]) => name), ['observe', 'execute', 'verify']);

  const unsupported = createAdapters({ sessionRunner: { ...sessionRunner, capabilities: ['observe'] } }).session;
  await assert.rejects(Promise.resolve().then(() => unsupported.observe({ cwd: '/work' })), { code: 'SESSION_CONTRACT_UNSUPPORTED' });
});

test('checkpoint adapter snapshots the worktree with a temporary index and honors excludes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-checkpoint-adapter-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(dir, '.gitignore'), 'ignored.log\nignored-tracked.txt\n');
    await writeFile(join(dir, 'tracked.txt'), 'base\n');
    await writeFile(join(dir, '.env.secret'), 'base-secret\n');
    await writeFile(join(dir, 'ignored-tracked.txt'), 'ignored base\n');
    git('add', '.gitignore', 'tracked.txt', '.env.secret');
    git('add', '-f', 'ignored-tracked.txt');
    git('commit', '-qm', 'baseline');
    await writeFile(join(dir, 'tracked.txt'), 'checkpoint\n');
    await writeFile(join(dir, 'new.txt'), 'new\n');
    await writeFile(join(dir, '.env.secret'), 'secret-change\n');
    await writeFile(join(dir, 'ignored.log'), 'ignored\n');
    const beforeStatus = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const beforeIndex = git('diff', '--cached', '--raw');
    const adapters = createAdapters({ repositoryRoot: dir });
    const created = await adapters.checkpoint.createCheckpoint({ ref: 'refs/harness/U-1/scope.1', exclude: ['**/.env*'] });
    assert.equal(created.worktreeChanged, false);
    assert.equal(created.indexChanged, false);
    assert.deepEqual(created.excluded, ['.env.secret', 'ignored-tracked.txt']);
    assert.equal(git('status', '--porcelain=v1', '-z', '--untracked-files=all'), beforeStatus);
    assert.equal(git('diff', '--cached', '--raw'), beforeIndex);
    assert.equal(git('show', 'refs/harness/U-1/scope.1:tracked.txt'), 'checkpoint');
    assert.notEqual(spawnSync('git', ['cat-file', '-e', 'refs/harness/U-1/scope.1:.env.secret'], { cwd: dir }).status, 0);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', 'refs/harness/U-1/scope.1:ignored-tracked.txt'], { cwd: dir }).status, 0);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', 'refs/harness/U-1/scope.1:ignored.log'], { cwd: dir }).status, 0);
    await assert.rejects(adapters.checkpoint.inspectChanges({
      checkpoint: created.ref, firstCheckpoint: created.ref, head: 'stale-head',
    }), { code: 'CHECKPOINT_STALE' });
    await writeFile(join(dir, 'tracked.txt'), 'attempt\n');
    await writeFile(join(dir, 'attempt.txt'), 'attempt\n');
    const beforeInspectStatus = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const beforeInspectIndex = git('diff', '--cached', '--raw');
    const changes = await adapters.checkpoint.inspectChanges({
      checkpoint: created.ref, firstCheckpoint: created.ref, exclude: ['**/.env*'],
    });
    assert.deepEqual(changes.attemptDiff, ['attempt.txt', 'tracked.txt']);
    assert.deepEqual(changes.firstCheckpointDiff, ['attempt.txt', 'tracked.txt']);
    assert.equal(git('status', '--porcelain=v1', '-z', '--untracked-files=all'), beforeInspectStatus);
    assert.equal(git('diff', '--cached', '--raw'), beforeInspectIndex);
    assert.equal(await readFile(join(dir, '.env.secret'), 'utf8'), 'secret-change\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('later checkpoints retain previously created references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-checkpoint-retain-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(dir, 'tracked.txt'), 'base\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'baseline');

    const checkpoint = createAdapters({ repositoryRoot: dir }).checkpoint;
    const first = await checkpoint.createCheckpoint({ ref: 'refs/harness/U-1/scope.1' });
    const firstSha = git('rev-parse', first.ref);
    await writeFile(join(dir, 'tracked.txt'), 'later\n');
    await checkpoint.createCheckpoint({ ref: 'refs/harness/U-1/implement.1' });

    assert.equal(git('rev-parse', first.ref), firstSha);
    assert.equal(git('show', `${first.ref}:tracked.txt`), 'base');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
