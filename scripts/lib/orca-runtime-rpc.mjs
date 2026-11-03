import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// Orca's CLI ships its matching runtime client beside the executable, rather than as an npm SDK.
export function createOrcaRuntimeRpc({ command, cwd }) {
  let client;
  return async (method, params) => {
    if (method !== 'terminal.inspectProcess') throw new TypeError('unsupported Orca runtime operation');
    if (!client) {
      const found = await command('which', ['orca'], {cwd});
      if (found.exitCode !== 0 || found.signal) throw new Error('Orca CLI is unavailable');
      const binary = await realpath(found.stdout.trim());
      const resources = path.dirname(path.dirname(binary));
      const modulePath = path.join(resources, 'app.asar.unpacked', 'out', 'cli', 'runtime-client.js');
      const require = createRequire(import.meta.url);
      const { RuntimeClient } = require(modulePath);
      if (typeof RuntimeClient !== 'function') throw new Error('Orca runtime client is incompatible');
      client = new RuntimeClient();
    }
    return client.call(method, params);
  };
}
