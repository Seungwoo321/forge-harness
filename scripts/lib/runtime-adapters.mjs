import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters } from './adapters.mjs';
import { formatCliResult } from './report.mjs';
import { parseUnitArgs, runUnitCli } from './unit-driver.mjs';

const operations = { git: ['inspectUnit'], gates: ['describe', 'run'], tracker: ['read', 'project'], effect: ['execute', 'verify'] };

export async function runPublicUnitCli(argv, { cwd = process.cwd(), contractsDir } = {}) {
  try {
    const { options } = parseUnitArgs(argv);
    const core = createAdapters({ repositoryRoot: cwd });
    let providers = {};
    if (options.adapters) {
      const module = await import(pathToFileURL(path.resolve(cwd, options.adapters)).href);
      if (typeof module.createRuntimeAdapters !== 'function') throw new TypeError('adapter module must export createRuntimeAdapters');
      providers = await module.createRuntimeAdapters({ cwd, adapters: core });
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)
        || Object.keys(providers).some(key => !['git', 'gates', 'tracker', 'sessionRunner', 'repository', 'provider', 'effect', 'effectContext'].includes(key))) {
        throw new TypeError('runtime providers may register only git, gates, tracker, sessionRunner, repository, provider, effect, and effectContext');
      }
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
    return await runUnitCli(argv, { cwd, contractsDir, adapters: Object.freeze({ ...core, ...injected, session }) });
  } catch (error) {
    return formatCliResult({ code: error.code === 'CLI_USAGE' ? 2 : 4, summary: 'Runtime adapter configuration failed', details: { error: error.code ?? 'ADAPTER_CONFIG_INVALID', message: error.message } });
  }
}
