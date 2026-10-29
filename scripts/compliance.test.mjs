import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCompliance } from './compliance.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-compliance-'));
  for (const directory of ['skills', 'scripts/lib', 'docs', 'hooks']) await mkdir(path.join(root, directory), { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'package.json', 'hooks/hooks.json']) await writeFile(path.join(root, file), '');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('compliance gate accepts generic read-only skills and deterministic controls', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'skills', 'review.md'), 'Read the result and report findings.');
    await writeFile(path.join(f.root, 'scripts/lib', 'control.mjs'), 'export const state = "Scoped";');
    await writeFile(path.join(f.root, 'docs', 'spec.md'), 'The control plane uses adapters.');
    assert.deepEqual(await runCompliance(f.root), { ok: true, findings: [] });
  } finally { await f.cleanup(); }
});

test('compliance gate identifies skill writes, control LLM calls and forbidden commands, and private artifact data', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'skills', 'bad.md'), 'writeFile(statePath, data)');
    await writeFile(path.join(f.root, 'scripts/lib', 'bad.mjs'), 'await client.responses.create(); run("git reset --hard");');
    await writeFile(path.join(f.root, 'docs', 'bad.md'), 'See /Users/private-user/work and person@private.example.');
    const result = await runCompliance(f.root);
    assert.equal(result.ok, false);
    assert.deepEqual(new Set(result.findings.map(item => item.rule)), new Set([
      'skill-state-write', 'control-llm-call', 'forbidden-command', 'private-path', 'account-email',
    ]));
  } finally { await f.cleanup(); }
});
