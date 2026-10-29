import { runPolicyCli } from './policy.mjs';

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
  const notice = await policyStartupNotice();
  if (notice) process.stdout.write(`${notice}\n`);
}
