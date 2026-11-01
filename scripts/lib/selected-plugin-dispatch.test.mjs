import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchSelectedPluginCallback, pluginBindingsPath } from './selected-plugin-dispatch.mjs';

async function packageDigest(root) {
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name);
      const metadata = await stat(absolute);
      if (metadata.isDirectory()) {
        if (directory === root && ['.git', '.local', 'node_modules'].includes(name)) continue;
        await walk(absolute);
      } else {
        files.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          mode: metadata.mode & 0o111 ? '100755' : '100644',
          bytes: await readFile(absolute),
        });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const hash = createHash('sha256');
  for (const file of files) {
    const name = Buffer.from(file.path);
    hash.update(BigInt(name.length).toString(16).padStart(16, '0'), 'hex');
    hash.update(name);
    hash.update(file.mode);
    hash.update(BigInt(file.bytes.length).toString(16).padStart(16, '0'), 'hex');
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

async function fixture(t, {
  callbackSource,
  callbackEvent = 'beforeUnitScopeSubmission',
  callbackContractVersion = '1',
  manifestVersion = '0.1.0',
  receiptPlugins,
  ignoreReceipt = true,
} = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'forge-plugin-dispatch-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, '.gitignore'), ignoreReceipt ? '.local/\n' : '');
  execFileSync('git', ['init', projectRoot], { stdio: 'ignore' });
  const packageRoot = path.join(projectRoot, '.local/studio-kit/packages/studio-harness/0.1.0');
  await mkdir(path.join(packageRoot, 'hooks'), { recursive: true });
  await writeFile(path.join(packageRoot, 'studio-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'studio-harness', version: manifestVersion }));
  const callbacks = [
    { event: 'prepareProjectSession', source: 'hooks/local-runtime-check.mjs' },
    { event: 'beforeUnitScopeSubmission', source: 'hooks/unit-input-check.mjs' },
    { event: 'beforeAcceptanceSubmission', source: 'hooks/acceptance-evidence-check.mjs' },
  ];
  await writeFile(path.join(packageRoot, 'hooks/catalog.json'), JSON.stringify({
    schemaVersion: 1,
    hooks: callbacks.map(({ event, source }) => ({
      id: `test-${event}`, scope: 'project', schemaVersion: 1,
      contractVersion: event === callbackEvent ? callbackContractVersion : '1', event, source,
    })),
  }));
  for (const { event, source } of callbacks) {
    await writeFile(path.join(packageRoot, source), event === callbackEvent && callbackSource ? callbackSource : `
export const event = ${JSON.stringify(event)};
export function inspect(input) { return { ok: true, event, input }; }
`);
  }
  const plugin = { id: 'studio-harness', version: '0.1.0', digest: await packageDigest(packageRoot), root: '.local/studio-kit/packages/studio-harness/0.1.0' };
  const receipt = {
    schemaVersion: 1,
    profile: { id: 'profile-1', revision: 3 },
    deployment: { operationId: 'deploy-1', revision: 'revision-1', state: 'applied' },
    plugins: receiptPlugins ?? [plugin],
  };
  const receiptFile = path.join(projectRoot, pluginBindingsPath);
  await mkdir(path.dirname(receiptFile), { recursive: true });
  await writeFile(receiptFile, JSON.stringify(receipt));
  let verifyCalls = 0;
  const verifyAppBinding = async () => { verifyCalls += 1; return receipt; };
  return { projectRoot, packageRoot, receipt, verifyAppBinding, get verifyCalls() { return verifyCalls; } };
}

const input = { unit: 'unit-a', selectedUnit: 'unit-a', owner: 'agent-a', actualOwner: 'agent-a', paused: false, inputs: [{ digest: 'a'.repeat(64), currentDigest: 'a'.repeat(64) }] };

function dispatch(f, options = {}) {
  return dispatchSelectedPluginCallback({
    projectRoot: f.projectRoot,
    event: options.event ?? 'beforeUnitScopeSubmission',
    input: options.input ?? input,
    inputFingerprint: 'fingerprint-1',
    readCurrentInputFingerprint: options.readCurrentInputFingerprint ?? (() => 'fingerprint-1'),
    verifyAppBinding: f.verifyAppBinding,
    timeoutMs: options.timeoutMs ?? 1000,
  });
}

test('dispatches only the App-selected project package and preserves the original input', async t => {
  const f = await fixture(t);
  const result = await dispatch(f);
  assert.deepEqual(result, { ok: true, event: 'beforeUnitScopeSubmission', input });
  assert.strictEqual(result.input, input);
  assert.equal(f.verifyCalls, 2);
});

test('dispatches each catalogued Studio Harness callback event', async t => {
  const f = await fixture(t);
  const events = [
    ['prepareProjectSession', { cwd: f.projectRoot, selectedCheckout: f.projectRoot, prerequisitesReady: true, effectivePolicyVerified: true, discovery: {} }],
    ['beforeUnitScopeSubmission', input],
    ['beforeAcceptanceSubmission', { criteria: ['AC-1'], requiredRules: ['tests'], inputFingerprint: 'f'.repeat(64), evidence: [] }],
  ];
  for (const [event, eventInput] of events) {
    assert.deepEqual(await dispatch(f, { event, input: eventInput }), { ok: true, event, input: eventInput });
  }
});

test('rejects provider-native hook events because their host trust gate is separate', async t => {
  const f = await fixture(t);
  await assert.rejects(dispatch(f, { event: 'SessionStart' }), { code: 'PLUGIN_DISPATCH_INVALID' });
  assert.equal(f.verifyCalls, 0);
});

test('requests current profile state from the project-bound App API before dispatch', async t => {
  const f = await fixture(t);
  const canonicalProjectRoot = await realpath(f.projectRoot);
  const url = `http://127.0.0.1:19500/v1/profiles/current/plugin-bindings?projectRoot=${encodeURIComponent(canonicalProjectRoot)}`;
  let requests = 0;
  const result = await dispatchSelectedPluginCallback({
    projectRoot: f.projectRoot,
    event: 'beforeUnitScopeSubmission',
    input,
    inputFingerprint: 'fingerprint-1',
    readCurrentInputFingerprint: () => 'fingerprint-1',
    env: { STUDIO_KIT_PLUGIN_BINDINGS_URL: url, STUDIO_KIT_PLUGIN_BINDINGS_TOKEN: 'session-token' },
    fetchImpl: async (requested, options) => {
      requests += 1;
      assert.equal(String(requested), url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer session-token');
      return { status: 200, async text() { return JSON.stringify(f.receipt); } };
    },
  });
  assert.deepEqual(result, { ok: true, event: 'beforeUnitScopeSubmission', input });
  assert.equal(requests, 2);
});

test('fails closed when the App reports an absent or unapplied binding', async t => {
  const f = await fixture(t);
  const canonicalProjectRoot = await realpath(f.projectRoot);
  const url = `http://127.0.0.1:19500/v1/profiles/current/plugin-bindings?projectRoot=${encodeURIComponent(canonicalProjectRoot)}`;
  await assert.rejects(dispatchSelectedPluginCallback({
    projectRoot: f.projectRoot,
    event: 'beforeUnitScopeSubmission',
    input,
    inputFingerprint: 'fingerprint-1',
    readCurrentInputFingerprint: () => 'fingerprint-1',
    env: { STUDIO_KIT_PLUGIN_BINDINGS_URL: url, STUDIO_KIT_PLUGIN_BINDINGS_TOKEN: 'session-token' },
    fetchImpl: async () => ({ status: 409, async text() { return '{"error":{"code":"DEPLOYMENT_NOT_APPLIED"}}'; } }),
  }), { code: 'PLUGIN_BINDING_UNAVAILABLE' });
});

test('rejects a binding receipt path that is not ignored by Git', async t => {
  const f = await fixture(t, { ignoreReceipt: false });
  await assert.rejects(dispatch(f), { code: 'PLUGIN_RECEIPT_UNVERIFIED' });
});

test('rejects a tampered full package digest before invoking its callback', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.packageRoot, 'extra.txt'), 'tampered');
  await assert.rejects(dispatch(f), { code: 'PLUGIN_DIGEST_MISMATCH' });
});

test('rejects a package version that disagrees with the applied App receipt', async t => {
  const f = await fixture(t, { manifestVersion: '0.2.0' });
  await assert.rejects(dispatch(f), /manifest or callback catalog version/);
});

test('rejects an unknown callback contract version', async t => {
  const f = await fixture(t, { callbackContractVersion: '2' });
  await assert.rejects(dispatch(f), { code: 'PLUGIN_CONTRACT_MISMATCH' });
});

test('rejects when the App profile has no Studio Harness selection', async t => {
  const f = await fixture(t, { receiptPlugins: [] });
  await assert.rejects(dispatch(f), { code: 'PLUGIN_NOT_SELECTED' });
});

test('rejects callback-declared failure and exceptions without forwarding input', async t => {
  const rejected = await fixture(t, { callbackSource: `
export const event = 'beforeUnitScopeSubmission';
export function inspect() { return { ok: false, event, reasons: ['stale snapshot'] }; }
` });
  await assert.rejects(dispatch(rejected), { code: 'PLUGIN_CALLBACK_REJECTED' });

  const thrown = await fixture(t, { callbackSource: `
export const event = 'beforeUnitScopeSubmission';
export function inspect() { throw new Error('callback crash'); }
` });
  await assert.rejects(dispatch(thrown), { code: 'PLUGIN_CALLBACK_FAILED' });
});

test('rejects a stale input before callback invocation', async t => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(dispatch(f, { readCurrentInputFingerprint: () => (++reads === 1 ? 'fingerprint-1' : 'stale') }), { code: 'PLUGIN_INPUT_STALE' });
});

test('fails closed on callback timeout and malformed response', async t => {
  const slow = await fixture(t, { callbackSource: `
export const event = 'beforeUnitScopeSubmission';
export async function inspect(input) { await new Promise(resolve => setTimeout(resolve, 4000)); return { ok: true, event, input }; }
` });
  const startedAt = Date.now();
  await assert.rejects(dispatch(slow, { timeoutMs: 1000 }), { code: 'PLUGIN_DISPATCH_TIMEOUT' });
  assert.ok(Date.now() - startedAt < 2500, 'timeout must terminate the child instead of waiting for callback completion');
  const processes = execFileSync('ps', ['-axo', 'ppid=,args='], { encoding: 'utf8' });
  assert.equal(processes.split('\n').some(line => line.trim().startsWith(`${process.pid} `) && line.includes('--allow-fs-read=')), false);

  const malformed = await fixture(t, { callbackSource: `
export const event = 'beforeUnitScopeSubmission';
export function inspect() { return 'ok'; }
` });
  await assert.rejects(dispatch(malformed), /malformed response/);
});

test('isolated callback cannot write files, read outside its package, use network, spawn or read parent secrets', async t => {
  const marker = path.join(tmpdir(), `forge-callback-write-${process.pid}`);
  await rm(marker, { force: true });
  const f = await fixture(t, { callbackSource: `
export const event = 'beforeUnitScopeSubmission';
export async function inspect(input) {
  const fs = await import('node:fs/promises');
  const child = await import('node:child_process');
  let writeDenied = false;
  let readDenied = false;
  let networkDenied = false;
  let processDenied = false;
  try { await fs.writeFile(${JSON.stringify(marker)}, 'no'); } catch { writeDenied = true; }
  try { await fs.readFile('/etc/passwd'); } catch { readDenied = true; }
  try { await fetch('http://127.0.0.1:1/'); } catch { networkDenied = true; }
  try { child.spawnSync(process.execPath, ['-e', 'process.exit(0)']); } catch { processDenied = true; }
  const environmentRestricted = process.env.FORGE_TEST_SECRET === undefined;
  const ok = writeDenied && readDenied && networkDenied && processDenied && environmentRestricted;
  return ok ? { ok: true, event, input } : { ok: false, event, reasons: [JSON.stringify({ writeDenied, readDenied, networkDenied, processDenied, environmentRestricted })] };
}
` });
  process.env.FORGE_TEST_SECRET = 'not-forwarded';
  try { assert.deepEqual(await dispatch(f), { ok: true, event: 'beforeUnitScopeSubmission', input }); }
  finally { delete process.env.FORGE_TEST_SECRET; }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
