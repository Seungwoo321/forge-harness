import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createAdapters } from './adapters.mjs';
import { formatCliResult } from './report.mjs';
import { parseUnitArgs, runUnitCli } from './unit-driver.mjs';

const operations = { git: ['inspectUnit'], gates: ['describe'], tracker: ['read', 'project'], effect: ['execute', 'verify'] };

export async function runPublicUnitCli(argv, { cwd = process.cwd(), contractsDir } = {}) {
  try {
    const { options } = parseUnitArgs(argv);
    const core = createAdapters({ repositoryRoot: cwd });
    let providers = {};
    if (options.adapters) {
      const module = await import(pathToFileURL(path.resolve(cwd, options.adapters)).href);
      if (typeof module.createRuntimeAdapters !== 'function') throw new TypeError('adapter module must export createRuntimeAdapters');
      providers = await module.createRuntimeAdapters({ cwd, adapters: core, options, argv });
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)
        || Object.keys(providers).some(key => !['git', 'gates', 'tracker', 'sessionRunner', 'repository', 'provider', 'effect', 'effectContext', 'processIdentity'].includes(key))) {
        throw new TypeError('runtime providers may register only git, gates, tracker, sessionRunner, repository, provider, effect, effectContext, and processIdentity');
      }
      if(providers.processIdentity!==undefined&&typeof providers.processIdentity!=='function')throw new TypeError('runtime processIdentity provider must be a function');
      if ((providers.effect !== undefined || providers.effectContext !== undefined)
        && (!providers.effect || typeof providers.effectContext !== 'function')) {
        throw new TypeError('runtime effect and effectContext must be registered together');
      }
      for (const [name, methods] of Object.entries(operations)) {
        if (providers[name] !== undefined && !methods.every(method => typeof providers[name]?.[method] === 'function')) {
          throw new TypeError(`runtime ${name} provider requires ${methods.join(', ')}`);
        }
      }
      if (providers.provider !== undefined && typeof providers.provider?.verifyUserInput !== 'function') {
        throw new TypeError('runtime provider requires verifyUserInput');
      }
    }
    const { sessionRunner, ...injected } = providers;
    const session = createAdapters({ sessionRunner }).session;
    const output = await runUnitCli(argv, { cwd, contractsDir, adapters: Object.freeze({ ...core, ...injected, session }) });
    const result = JSON.parse(output.slice(output.lastIndexOf('RESULT ') + 7));
    if (argv[0] === 'unit' && ['finish', 'session-stop', 'session-return'].includes(argv[1]) && result.finalizePending && options.adapters) {
      const directory = path.join(result.stateRoot, 'units', argv[2]);
      await mkdir(directory, { recursive: true });
      // The detached finalizer keeps re-observing a pending delivery for up to two hours, so a busy owner still receives the
      // result and the finished session closes without someone rerunning finalize.
      const arguments_ = [fileURLToPath(new URL('../unit.mjs', import.meta.url)), 'unit', 'finalize', argv[2], '--adapters', path.resolve(cwd, options.adapters), '--wait', '7200', '--interval', '30'];
      for (const key of ['state-root', 'project-root']) if (options[key]) arguments_.push(`--${key}`, path.resolve(cwd, options[key]));
      await core.detach(process.execPath, arguments_, { cwd, logPath: path.join(directory, 'finalization.log') });
    }
    return output;
  } catch (error) {
    return formatCliResult({ code: error.code === 'CLI_USAGE' ? 2 : 4, summary: 'Runtime adapter configuration failed', details: { error: error.code ?? 'ADAPTER_CONFIG_INVALID', message: error.message } });
  }
}
