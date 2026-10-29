#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createAdapters } from './lib/adapters.mjs';
import { detectPolicyClues, resolveStoredPolicy, setPolicy } from './lib/policy-store.mjs';
import { formatCliResult } from './lib/report.mjs';

function parse(argv) {
  const positional = [];
  const options = {};
  const valued = new Set(['state-root', 'project-root', 'workspace-root', 'global-root', 'draft', 'reason', 'user-input-ref', 'remote', 'level']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (key === 'non-interactive' || key === 'change' || key === 'json') {
      if (options[key] !== undefined) throw new TypeError(`duplicate option: ${arg}`);
      options[key] = true;
      continue;
    }
    if (!valued.has(key) || options[key] !== undefined) throw new TypeError(`unknown or duplicate option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`missing value for ${arg}`);
    options[key] = value;
  }
  return { positional, options };
}

async function statePaths(options, cwd, adapters) {
  const projectRoot = path.resolve(cwd, options['project-root'] ?? '.');
  let stateRoot = options['state-root'] ? path.resolve(cwd, options['state-root']) : undefined;
  if (!stateRoot) {
    const git = await adapters.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: projectRoot });
    if (git.exitCode !== 0 || !git.stdout.trim()) throw Object.assign(new Error('Git state root unavailable; pass --state-root and --project-root'), { code: 'ADAPTER_MISSING' });
    stateRoot = path.join(git.stdout.trim(), 'work-state');
  }
  if (options['state-root'] && !options['project-root']) throw new TypeError('--state-root requires --project-root outside a Git checkout');
  return { stateRoot, projectRoot, workspaceRoot: options['workspace-root'] ? path.resolve(cwd, options['workspace-root']) : undefined, globalRoot: options['global-root'] ? path.resolve(cwd, options['global-root']) : undefined };
}

export async function runPolicyCli(argv, { cwd = process.cwd(), adapters = createAdapters() } = {}) {
  try {
    const { positional, options } = parse(argv);
    if (positional[0] !== 'policy' || !['resolve', 'detect', 'set', 'show', 'startup-notice'].includes(positional[1])) throw new TypeError('usage: policy resolve|detect|set|show|startup-notice');
    const [,, ...rest] = positional;
    const paths = await statePaths(options, cwd, adapters);
    if (rest.length) throw new TypeError('unexpected positional arguments');
    if (positional[1] === 'detect') {
      const clues = await detectPolicyClues({ ...paths, remote: options.remote, command: adapters.command });
      return formatCliResult({ code: 0, summary: 'Policy clues collected', details: clues });
    }
    if (positional[1] === 'set') {
      if (!options.draft || !options['level']) throw new TypeError('policy set requires --level and --draft');
      const draft = JSON.parse(await readFile(path.resolve(cwd, options.draft), 'utf8'));
      const result = await setPolicy({
        level: options.level, draft, ...paths, change: options.change === true,
        reason: options.reason, userInputRef: options['user-input-ref'], adapters,
      });
      return formatCliResult({ code: 0, summary: `Policy saved at ${result.level}`, details: result });
    }
    if (positional[1] === 'startup-notice') {
      try {
        await resolveStoredPolicy({ ...paths, remote: options.remote });
        return formatCliResult({ code: 0, summary: 'Work policy is configured', details: { notice: null } });
      } catch (error) {
        if (error.code !== 'POLICY_UNSET') throw error;
        return formatCliResult({ code: 0, summary: 'Work policy is not configured; run policy-setup before starting a unit.', details: { notice: 'POLICY_UNSET' } });
      }
    }
    if (positional[1] === 'resolve' && (options['non-interactive'] || options['workspace-root'] || options['global-root'] || options.remote)) {
      const result = await resolveStoredPolicy({ ...paths, remote: options.remote, nonInteractive: options['non-interactive'] === true });
      return formatCliResult({ code: 0, summary: 'Policy resolved', details: result });
    }
    const result = await resolveStoredPolicy({ ...paths, remote: options.remote, nonInteractive: options['non-interactive'] === true });
    return formatCliResult({ code: 0, summary: 'Policy resolved', details: result });
  } catch (error) {
    const code = error.exitCode ?? (error.code === 'POLICY_UNSET' ? 3 : error.code === 'ENOENT' ? 2 : 2);
    return formatCliResult({ code, summary: error.message, details: { error: error.code ?? 'POLICY_INVALID' } });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPolicyCli(process.argv.slice(2));
  process.stdout.write(`${result}\n`);
  process.exitCode = JSON.parse(result.slice(result.lastIndexOf('RESULT ') + 7)).code;
}
