import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sessionAdapterContract = 'harness.session-adapter/1';
const sessionAdapterCapabilities = [
  'fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review',
];

// The subprocess owns the protocol connection; callers only receive native responses.
export async function withJsonRpcProcess(binary, args, action, { cwd, timeoutMs = 15000 } = {}) {
  const child = nodeSpawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const timer = setTimeout(() => { fail(new Error('worker protocol timeout')); child.kill(); }, timeoutMs);
  child.on('error', fail);
  child.on('exit', () => fail(new Error('worker protocol exited')));
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('invalid worker protocol JSON')); continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), {rpcCode:message.error.code})); else entry.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    const initialization = await rpc('initialize', { clientInfo: { name: 'session_transport', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return await action(rpc, initialization);
  } finally { clearTimeout(timer); child.kill(); }
}

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
      const output = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
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
    async createCheckpoint({ ref, exclude = [], head: expectedHead, inputDigest, legacy = false }) {
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
        const message = `Checkpoint ${ref}${inputDigest ? `\n\nStageInput ${inputDigest}` : ''}\n`;
        const existing = await command('git', ['show-ref', '--verify', '--quiet', ref], { cwd });
        let commit;
        if (existing.exitCode === 0) {
          commit = (await git(['rev-parse', '--verify', ref], { cwd })).trim();
          const raw = await git(['cat-file', 'commit', commit], { cwd });
          const boundary = raw.indexOf('\n\n');
          const headers = raw.slice(0, boundary).split('\n');
          const parents = headers.filter(line => line.startsWith('parent '));
          const identity = /^(author|committer) Forge Harness <forge-harness@localhost> \d+ [+-]\d{4}$/;
          const knownMessage = raw.slice(boundary + 2) === message
            || legacy && raw.slice(boundary + 2) === `Checkpoint ${ref}\n`;
          if ((!inputDigest && !legacy) || !knownMessage || parents.length !== 1 || parents[0] !== `parent ${snapshot.head}`
            || headers[0] !== `tree ${snapshot.tree}` || headers.length !== 4
            || !identity.test(headers[2]) || !identity.test(headers[3])) {
            throw Object.assign(new Error('existing checkpoint does not match the stage input, head, tree or provenance'), { code: 'CHECKPOINT_CONFLICT' });
          }
        } else {
          if (existing.exitCode !== 1) throw Object.assign(new Error('checkpoint reference inspection failed'), { code: 'ADAPTER_GIT_FAILED' });
          commit = (await git(['-c', 'user.name=Forge Harness', '-c', 'user.email=forge-harness@localhost', 'commit-tree', snapshot.tree, '-p', snapshot.head, '-m', message], { cwd })).trim();
        }
        const currentHead = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
        if (currentHead !== snapshot.head) {
          const error = new Error('repository head changed during checkpoint creation');
          error.code = 'CHECKPOINT_STALE';
          throw error;
        }
        if (existing.exitCode !== 0) await git(['update-ref', ref, commit, '0'.repeat(commit.length)], { cwd });
        else if ((await git(['rev-parse', '--verify', ref], { cwd })).trim() !== commit) {
          throw Object.assign(new Error('checkpoint reference changed during recovery'), { code: 'CHECKPOINT_CONFLICT' });
        }
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
    async inspectChanges({ checkpoint: attempt, firstCheckpoint, exclude = [], head: expectedHead, paths }) {
      const current = await snapshotTree(exclude);
      try {
        if (expectedHead && current.head !== expectedHead) {
          const error = new Error('repository head changed since the stage checkpoint');
          error.code = 'CHECKPOINT_STALE';
          throw error;
        }
        const diff = async commit => (await git(['diff', '--name-only', '-z', commit, current.tree], { cwd: current.cwd }))
          .split('\0').filter(Boolean);
        const patch = paths === undefined ? {} : { patch: paths.length
          ? await git(['--literal-pathspecs', 'diff', '--binary', '--no-ext-diff', '--no-textconv', firstCheckpoint, current.tree, '--', ...paths], { cwd: current.cwd }) : '' };
        return { head: current.head, tree: current.tree, firstCheckpointDiff: await diff(firstCheckpoint), attemptDiff: await diff(attempt), ...patch };
      } finally {
        await rm(current.temp, { recursive: true, force: true });
      }
    },
  });

  return Object.freeze({
    command,
    async detach(binary, args, { cwd, logPath }) {
      const log = await open(logPath, 'a', 0o600);
      try {
        const child = spawn(binary, args, { cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        return { pid: child.pid };
      } finally { await log.close(); }
    },
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
