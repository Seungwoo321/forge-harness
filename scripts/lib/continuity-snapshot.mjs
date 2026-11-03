import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
let sequence = 0;

export async function snapshotText(stateRoot, goalId, content, extension) {
  if (typeof goalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(goalId) || goalId === '..' || !['json','md'].includes(extension) || typeof content !== 'string') throw new TypeError('invalid snapshot');
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const directory = path.join(path.resolve(stateRoot), 'goals', goalId, 'snapshots');
  const file = path.join(directory, `${digest.slice(7)}.${extension}`);
  await mkdir(directory, { recursive: true });
  try {
    if (await readFile(file, 'utf8') !== content) throw Object.assign(new Error('snapshot content differs'), { code: 'CONTINUITY_STALE' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = `${file}.tmp-${process.pid}-${++sequence}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
      const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  return { path: file, digest };
}

export async function snapshotGoal(stateRoot, record) {
  return snapshotText(stateRoot, record.goal.id, `${JSON.stringify(record, null, 2)}\n`, 'json');
}
