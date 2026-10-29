import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));

test('distribution versions, discovered skills, asset dimensions, and local documentation links agree', async () => {
  const pkg = await json('package.json');
  const claude = await json('.claude-plugin/plugin.json');
  const codex = await json('.codex-plugin/plugin.json');
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    assert.equal((await json(file)).plugins[0].version, pkg.version);
  }
  for (const directory of await readdir(path.join(root, 'skills'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const entry = directory.name;
    const body = await readFile(path.join(root, 'skills', entry, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`^---\\nname: ${entry}\\n`));
    assert.match(body, /description: .+/);
  }
  const assets = [codex.interface.composerIcon, codex.interface.logo, ...codex.interface.screenshots];
  for (const file of assets) {
    assert.match(file, /^\.\/assets\/[^/]+\.(svg|png)$/);
    assert.ok((await stat(path.join(root, file))).size <= 5 * 1024 * 1024);
  }
  for (const file of [codex.interface.composerIcon, codex.interface.logo]) {
    const svg = await readFile(path.join(root, file), 'utf8');
    const dimensions = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(dimensions);
    assert.equal(dimensions[1], dimensions[2]);
    assert.ok(Number(dimensions[1]) >= 48);
  }
  for (const file of ['README.md', 'docs/getting-started.md', 'docs/runtime-adapters.md']) {
    const body = await readFile(path.join(root, file), 'utf8');
    for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      const target = path.resolve(root, path.dirname(file), match[1]);
      assert.ok(target.startsWith(root));
      assert.ok(await stat(target), `${file}: ${match[1]}`);
    }
  }
});

test('a package relocated outside the source checkout completes the documented first-run boundary', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'distribution-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const installed = path.join(temporary, 'installed package');
  for (const entry of ['scripts', 'skills', 'examples', 'package.json']) {
    await cp(path.join(root, entry), path.join(installed, entry), { recursive: true });
  }
  const result = spawnSync(process.execPath, [path.join(installed, 'examples/first-run.mjs')], { cwd: temporary, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS: packaged policy, scope submission, and implement input/);
  assert.equal(result.stdout, await readFile(path.join(root, 'examples/first-run.txt'), 'utf8'));
  const capture = await readFile(path.join(root, 'assets/first-run.svg'), 'utf8');
  for (const line of result.stdout.trim().split('\n')) assert.ok(capture.includes(line));
});
