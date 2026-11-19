import { createWatchIO } from './lib/lifecycle-watch-io.mjs';
import { watchStateRoot } from './lib/lifecycle-watch-cli.mjs';
import { ensureWatchRunner } from './lib/lifecycle-watch-runner.mjs';
import { runPolicyCli } from './policy.mjs';

export async function recoverWatchRunner({cwd=process.cwd(),io=createWatchIO()}={}) {
  const stateRoot = await watchStateRoot({cwd,io});
  return ensureWatchRunner({stateRoot,io});
}

export async function policyStartupNotice({ cwd = process.cwd(), adapters } = {}) {
  try {
    const result = await runPolicyCli(['policy', 'startup-notice'], { cwd, adapters });
    const firstLine = result.split('\n', 1)[0];
    return firstLine.includes('not configured') ? firstLine : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    await recoverWatchRunner();
  } catch (error) { process.stderr.write(`Watch recovery: ${error.message}\n`); }
  const notice = await policyStartupNotice();
  if (notice) process.stdout.write(`${notice}\n`);
}
