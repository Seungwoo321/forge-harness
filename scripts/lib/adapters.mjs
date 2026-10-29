import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sessionAdapterContract = 'harness.session-adapter/1';
const sessionAdapterCapabilities = [
  'fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review',
];

function registerSessionRunner(runner) {
  if (runner === undefined || runner === null) return null;
  if (!runner || typeof runner !== 'object' || Array.isArray(runner)
    || runner.contractVersion !== sessionAdapterContract
    || !Array.isArray(runner.capabilities)
    || !sessionAdapterCapabilities.every(capability => runner.capabilities.includes(capability))
    || !['observe', 'execute', 'verify'].every(name => typeof runner[name] === 'function')) {
    const error = new TypeError(`session runner must implement ${sessionAdapterContract} and its required capabilities`);
    error.code = 'SESSION_CONTRACT_UNSUPPORTED';
    return Object.freeze(Object.fromEntries(['observe', 'execute', 'verify'].map(name => [name, () => { throw error; }])));
  }
  return Object.freeze({
    contractVersion: runner.contractVersion,
    capabilities: Object.freeze([...runner.capabilities]),
    observe: input => runner.observe(input),
    execute: input => runner.execute(input),
    verify: input => runner.verify(input),
  });
}

function matchesGlob(file, pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?'; }
      else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`).test(file);
}

export function createAdapters({ spawn = nodeSpawn, clock = () => new Date(), id = randomUUID, repositoryRoot = process.cwd(), sessionRunner } = {}) {
  if (typeof spawn !== 'function' || typeof clock !== 'function' || typeof id !== 'function') {
    throw new TypeError('adapter providers must be functions');
  }

  const command = (command, args = [], options = {}) => {
      if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)
        || args.some(argument => typeof argument !== 'string')) {
        throw new TypeError('command requires a binary and a string argument list');
      }
      const { cwd, env, signal, input } = options;
      if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) throw new TypeError('cwd must be a non-empty path');
      if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env))) throw new TypeError('env must be an object');
      if (input !== undefined && typeof input !== 'string') throw new TypeError('input must be a string');

      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(command, args, {
            cwd,
            env: env === undefined ? process.env : { ...process.env, ...env },
            shell: false,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            signal,
          });
        } catch (error) {
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        if (input !== undefined) child.stdin.end(input);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (exitCode, exitSignal) => resolve({ stdout, stderr, exitCode, signal: exitSignal }));
      });
  };

  async function git(args, options = {}) {
    const result = await command('git', args, options);
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr.trim() || `git ${args[0]} failed`);
      error.code = 'ADAPTER_GIT_FAILED';
      throw error;
    }
    return result.stdout;
  }

  async function snapshotTree(exclude = []) {
    const cwd = repositoryRoot;
    const temp = await mkdtemp(path.join(os.tmpdir(), 'forge-checkpoint-'));
    const index = path.join(temp, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      const head = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
      await git(['read-tree', head], { cwd, env });
      const output = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });
      const files = output.split('\0').filter(Boolean);
      let ignored = [];
      if (files.length) {
        const result = await command('git', ['check-ignore', '--no-index', '-v', '-z', '--stdin'], { cwd, input: `${files.join('\0')}\0` });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          const error = new Error(result.stderr.trim() || 'git check-ignore failed');
          error.code = 'ADAPTER_GIT_FAILED';
          throw error;
        }
        const fields = result.stdout.split('\0').filter(Boolean);
        ignored = fields.filter((_, index) => index % 4 === 3);
      }
      const excludedPaths = new Set(ignored);
      for (const file of files) if (exclude.some(pattern => matchesGlob(file, pattern))) excludedPaths.add(file);
      const excluded = [...excludedPaths].sort();
      const included = files.filter(file => !excluded.includes(file));
      if (included.length) await git(['add', '-A', '--', ...included], { cwd, env });
      for (const file of excluded) await git(['rm', '--cached', '--ignore-unmatch', '--', file], { cwd, env });
      const tree = (await git(['write-tree'], { cwd, env })).trim();
      return { cwd, temp, env, head, tree, excluded };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  const checkpoint = Object.freeze({
    async createCheckpoint({ ref, exclude = [], head: expectedHead }) {
      const cwd = repositoryRoot;
      const readonly = { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } };
      const beforeStatus = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], readonly);
      const beforeIndex = await git(['diff', '--cached', '--raw'], readonly);
      const indexPath = (await git(['rev-parse', '--git-path', 'index'], { cwd })).trim();
      const beforeIndexBytes = await readFile(path.resolve(cwd, indexPath));
      const snapshot = await snapshotTree(exclude);
      try {
        if (expectedHead && expectedHead !== snapshot.head) {
          const error = new Error('unit target head changed before checkpoint creation');
          error.code = 'CHECKPOINT_STALE';
          throw error;
        }
        const commit = (await git(['-c', 'user.name=Forge Harness', '-c', 'user.email=forge-harness@localhost', 'commit-tree', snapshot.tree, '-p', snapshot.head, '-m', `Checkpoint ${ref}`], { cwd })).trim();
        const currentHead = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
        if (currentHead !== snapshot.head) {
          const error = new Error('repository head changed during checkpoint creation');
          error.code = 'CHECKPOINT_STALE';
          throw error;
        }
        const zero = '0'.repeat(commit.length);
        await git(['update-ref', ref, commit, zero], { cwd });
        const afterStatus = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], readonly);
        const afterIndex = await git(['diff', '--cached', '--raw'], readonly);
        const afterIndexBytes = await readFile(path.resolve(cwd, indexPath));
        return {
          ref, commit, head: snapshot.head, excluded: snapshot.excluded,
          worktreeChanged: beforeStatus !== afterStatus,
          indexChanged: beforeIndex !== afterIndex || !beforeIndexBytes.equals(afterIndexBytes),
        };
      } finally {
        await rm(snapshot.temp, { recursive: true, force: true });
      }
    },
    async inspectChanges({ checkpoint: attempt, firstCheckpoint, exclude = [], head: expectedHead }) {
      const current = await snapshotTree(exclude);
      try {
        if (expectedHead && current.head !== expectedHead) {
          const error = new Error('repository head changed since the stage checkpoint');
          error.code = 'CHECKPOINT_STALE';
          throw error;
        }
        const diff = async commit => (await git(['diff', '--name-only', '-z', commit, current.tree], { cwd: current.cwd }))
          .split('\0').filter(Boolean);
        return { head: current.head, firstCheckpointDiff: await diff(firstCheckpoint), attemptDiff: await diff(attempt) };
      } finally {
        await rm(current.temp, { recursive: true, force: true });
      }
    },
  });

  return Object.freeze({
    command,
    checkpoint,
    session: registerSessionRunner(sessionRunner),
    now() {
      const value = clock();
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock adapter must return a valid Date');
      return value.toISOString();
    },
    id() {
      const value = id();
      if (typeof value !== 'string' || value.length === 0) throw new TypeError('id adapter must return a non-empty string');
      return value;
    },
  });
}
