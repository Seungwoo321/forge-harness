import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

export async function withGitHeadLock({ cwd, adapters, refs = [] }, action) {
  const git = async args => {
    const result = await adapters.command('git', args, { cwd });
    if (result.exitCode !== 0) throw Object.assign(new Error('cannot inspect Git head for stage recovery'), { code: 'STAGE_STALE' });
    return result.stdout.trim();
  };
  if (await git(['rev-parse', '--show-ref-format']) !== 'files') throw Object.assign(new Error('unsupported Git reference storage for stage recovery'), { code: 'STAGE_STALE' });
  const locks = [];
  const acquire = async name => {
    const lock = `${path.resolve(cwd, await git(['rev-parse', '--git-path', name]))}.lock`;
    if (locks.some(item => item.lock === lock)) return;
    await mkdir(path.dirname(lock), { recursive: true });
    const handle = await open(lock, 'wx', 0o600);
    locks.push({ lock, handle });
  };
  try {
    await acquire('HEAD');
    const symbolic = await adapters.command('git', ['symbolic-ref', '-q', '--no-recurse', 'HEAD'], { cwd });
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim();
      if (!ref.startsWith('refs/')) throw Object.assign(new Error('invalid symbolic HEAD'), { code: 'STAGE_STALE' });
      await acquire(ref);
      const indirect = await adapters.command('git', ['symbolic-ref', '-q', '--no-recurse', ref], { cwd });
      if (indirect.exitCode !== 1) throw Object.assign(new Error('indirect symbolic HEAD is unsupported for stage recovery'), { code: 'STAGE_STALE' });
    } else if (symbolic.exitCode !== 1) throw Object.assign(new Error('cannot inspect symbolic HEAD'), { code: 'STAGE_STALE' });
    for (const ref of refs) {
      await acquire(ref);
      const indirect = await adapters.command('git', ['symbolic-ref', '-q', '--no-recurse', ref], { cwd });
      if (indirect.exitCode !== 1) throw Object.assign(new Error('indirect Git base reference is unsupported for scope recovery'), { code: 'STAGE_STALE' });
    }
    return await action();
  } finally {
    for (const { lock, handle } of locks.reverse()) { await handle.close(); await rm(lock, { force: true }); }
  }
}
