import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const pluginBindingsPath = '.local/studio-kit/plugin-bindings.json';
const packageRootPath = '.local/studio-kit/packages';
const supportedPluginId = 'studio-harness';
const supportedSchemaVersion = 1;
const supportedContractVersion = '1';

function reject(message, code = 'PLUGIN_DISPATCH_REJECTED') {
  throw Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function withinTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(Object.assign(new Error(message), { code: 'PLUGIN_DISPATCH_TIMEOUT' })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sandboxLiteral(value) {
  return JSON.stringify(value);
}

function callbackRunnerSource() {
  return `
const { createHash } = await import('node:crypto');
const { lstat, readFile, readdir } = await import('node:fs/promises');
const path = await import('node:path');
const { pathToFileURL } = await import('node:url');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error('package contains a symlink');
    if (metadata.isDirectory()) {
      if (directory === request.packageRoot && ['.git', '.local', 'node_modules'].includes(entry.name)) continue;
      await walk(absolute);
    } else if (metadata.isFile()) {
      files.push({ path: path.relative(request.packageRoot, absolute).split(path.sep).join('/'), mode: metadata.mode & 0o111 ? '100755' : '100644', bytes: await readFile(absolute) });
    } else throw new Error('package contains a special file');
  }
}
async function digest() {
  await walk(request.packageRoot);
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
try {
  if (await digest() !== request.packageDigest) throw new Error('package digest changed before callback');
  const callback = await import(pathToFileURL(request.source).href);
  if (callback.event !== request.event || typeof (callback.inspect ?? callback.default) !== 'function') throw new Error('callback contract is malformed');
  const response = await (callback.inspect ?? callback.default)(request.input);
  process.stdout.write(JSON.stringify({ response }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error?.message ?? 'callback failed' }));
  process.exitCode = 1;
}
`;
}

async function executeCallbackIsolated({ packageRoot, source, digest, event, input, timeoutMs }) {
  if (process.platform !== 'darwin') reject('callback isolation is unsupported on this platform', 'PLUGIN_ISOLATION_UNSUPPORTED');
  const sandbox = '/usr/bin/sandbox-exec';
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(deny network*)',
    '(deny process-fork)',
    '(deny process-exec)',
    `(allow process-exec (literal ${sandboxLiteral(process.execPath)}))`,
  ].join('\n');
  const args = ['-p', profile, process.execPath, '--permission', `--allow-fs-read=${packageRoot}`, '--input-type=module', '-e', callbackRunnerSource()];
  return new Promise((resolve, rejectPromise) => {
    let child;
    try { child = spawn(sandbox, args, { shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) {
      rejectPromise(Object.assign(new Error(`callback sandbox could not start: ${error.message}`), { code: 'PLUGIN_ISOLATION_UNAVAILABLE' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      timeoutError = Object.assign(new Error('callback execution timed out'), { code: 'PLUGIN_DISPATCH_TIMEOUT' });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill('SIGKILL');
        finish(Object.assign(new Error('callback response exceeded the size limit'), { code: 'PLUGIN_CALLBACK_OUTPUT_INVALID' }));
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(Object.assign(new Error(`callback sandbox failed: ${error.message}`), { code: 'PLUGIN_ISOLATION_UNAVAILABLE' })));
    child.once('close', code => {
      if (timeoutError) {
        finish(timeoutError);
        return;
      }
      let result;
      try { result = JSON.parse(stdout); } catch { result = null; }
      if (code !== 0) {
        finish(Object.assign(new Error(result?.error ?? stderr.trim() ?? 'callback sandbox rejected execution'), {
          code: result?.error?.includes('digest changed') ? 'PLUGIN_DIGEST_MISMATCH' : 'PLUGIN_CALLBACK_FAILED',
        }));
        return;
      }
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'response')) {
        finish(Object.assign(new Error('callback returned malformed output'), { code: 'PLUGIN_CALLBACK_OUTPUT_INVALID' }));
        return;
      }
      finish(null, result.response);
    });
    child.stdin.end(JSON.stringify({ packageRoot, source, packageDigest: digest, event, input }));
  });
}

async function assertReceiptIgnored(projectRoot, timeoutMs) {
  await new Promise((resolve, rejectPromise) => {
    let child;
    try {
      child = spawn('git', ['-C', projectRoot, 'check-ignore', '--quiet', '--', pluginBindingsPath], {
        shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore',
      });
    } catch (error) {
      rejectPromise(Object.assign(new Error(`could not verify ignored binding receipt: ${error.message}`), { code: 'PLUGIN_RECEIPT_UNVERIFIED' }));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(Object.assign(new Error('binding receipt ignore check timed out'), { code: 'PLUGIN_DISPATCH_TIMEOUT' }));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      rejectPromise(Object.assign(new Error(`could not verify ignored binding receipt: ${error.message}`), { code: 'PLUGIN_RECEIPT_UNVERIFIED' }));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else rejectPromise(Object.assign(new Error('project binding receipt is not ignored by Git'), { code: 'PLUGIN_RECEIPT_UNVERIFIED' }));
    });
  });
}

async function readRegularJson(file) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) reject(`expected a regular file: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function packageFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) reject(`plugin package contains a symlink: ${absolute}`);
      if (metadata.isDirectory()) {
        if (directory === root && ['.git', '.local', 'node_modules'].includes(entry.name)) continue;
        await walk(absolute);
      } else if (metadata.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        const mode = metadata.mode & 0o111 ? '100755' : '100644';
        files.push({ relative, mode, bytes: await readFile(absolute) });
      } else reject(`plugin package contains a special file: ${absolute}`);
    }
  }
  await walk(root);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
  return files;
}

async function digestPackage(root) {
  const hash = createHash('sha256');
  for (const file of await packageFiles(root)) {
    const relative = Buffer.from(file.relative);
    const mode = Buffer.from(file.mode);
    hash.update(BigInt(relative.length).toString(16).padStart(16, '0'), 'hex');
    hash.update(relative);
    hash.update(mode);
    hash.update(BigInt(file.bytes.length).toString(16).padStart(16, '0'), 'hex');
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

function assertReceipt(receipt, localReceipt) {
  if (!receipt || receipt.schemaVersion !== supportedSchemaVersion
    || receipt.deployment?.state !== 'applied'
    || typeof receipt.profile?.id !== 'string' || !receipt.profile.id
    || !Number.isSafeInteger(receipt.profile.revision)
    || typeof receipt.deployment.operationId !== 'string' || !receipt.deployment.operationId
    || typeof receipt.deployment.revision !== 'string' || !receipt.deployment.revision
    || !Array.isArray(receipt.plugins)) reject('App did not verify a current applied plugin binding');
  if (!equalJson(receipt, localReceipt)) reject('project binding receipt changed while App state was verified', 'PLUGIN_BINDING_STALE');
  const selected = receipt.plugins.filter(plugin => plugin?.id === supportedPluginId);
  if (selected.length !== 1) reject('App project profile does not select exactly one Studio Harness package', 'PLUGIN_NOT_SELECTED');
  const plugin = selected[0];
  if (typeof plugin.version !== 'string' || !plugin.version
    || typeof plugin.digest !== 'string' || !/^[a-f0-9]{64}$/.test(plugin.digest)
    || plugin.root !== `${packageRootPath}/${supportedPluginId}/${plugin.version}`) {
    reject('App binding has an invalid Studio Harness package reference');
  }
  return plugin;
}

async function assertNoSymlinkPath(root, relative) {
  const parts = relative.split('/');
  let current = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') reject('plugin package path is not normalized');
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) reject(`plugin package path traverses a symlink: ${relative}`);
  }
  const canonical = await realpath(current);
  if (!canonical.startsWith(`${root}${path.sep}`)) reject('plugin package resolved outside the project root');
  return canonical;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

/**
 * Dispatch one Studio Harness callback using the App-verified project binding.
 * `verifyAppBinding` must call the current App binding API and reject stale or
 * unapplied profile state; the local receipt is only a deployment projection.
 */
export async function dispatchSelectedPluginCallback({
  projectRoot,
  event,
  input,
  inputFingerprint,
  readCurrentInputFingerprint,
  verifyAppBinding = verifyCurrentAppBinding,
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = 5000,
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
    || !['prepareProjectSession', 'beforeUnitScopeSubmission', 'beforeAcceptanceSubmission'].includes(event)
    || !input || typeof input !== 'object' || Array.isArray(input)
    || typeof inputFingerprint !== 'string' || !inputFingerprint
    || typeof readCurrentInputFingerprint !== 'function'
    || typeof verifyAppBinding !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    reject('selected plugin dispatch requires a complete verified input and App verifier', 'PLUGIN_DISPATCH_INVALID');
  }
  const canonicalProjectRoot = await realpath(projectRoot);
  const receiptFile = await assertNoSymlinkPath(canonicalProjectRoot, pluginBindingsPath);
  await assertReceiptIgnored(canonicalProjectRoot, timeoutMs);
  const localReceipt = await readRegularJson(receiptFile);
  const verifyCurrent = async () => {
    const receipt = await withinTimeout(
      Promise.resolve().then(() => verifyAppBinding({ projectRoot: canonicalProjectRoot, receiptPath: pluginBindingsPath, fetchImpl, env, timeoutMs })),
      timeoutMs,
      'App plugin binding verification timed out',
    );
    assertReceipt(receipt, await readRegularJson(receiptFile));
    return receipt;
  };
  const verifiedReceipt = await verifyCurrent();
  const plugin = assertReceipt(verifiedReceipt, localReceipt);
  const packageDirectory = await assertNoSymlinkPath(canonicalProjectRoot, plugin.root);
  const manifest = await readRegularJson(path.join(packageDirectory, 'studio-plugin.json'));
  const catalog = await readRegularJson(path.join(packageDirectory, 'hooks', 'catalog.json'));
  if (manifest.id !== supportedPluginId || manifest.version !== plugin.version
    || manifest.schemaVersion !== supportedSchemaVersion
    || catalog.schemaVersion !== supportedSchemaVersion || !Array.isArray(catalog.hooks)) {
    reject('Studio Harness manifest or callback catalog version does not match the App binding');
  }
  if (await digestPackage(packageDirectory) !== plugin.digest) reject('installed Studio Harness package digest does not match the App binding', 'PLUGIN_DIGEST_MISMATCH');
  const callbacks = catalog.hooks.filter(item => item?.event === event);
  if (callbacks.length !== 1) reject(`Studio Harness does not declare exactly one ${event} callback`, 'PLUGIN_CALLBACK_UNAVAILABLE');
  const callback = callbacks[0];
  if (callback.scope !== 'project' || callback.schemaVersion !== supportedSchemaVersion
    || callback.contractVersion !== supportedContractVersion || typeof callback.source !== 'string') {
    reject('Studio Harness callback schema or contract version is unsupported', 'PLUGIN_CONTRACT_MISMATCH');
  }
  const source = await assertNoSymlinkPath(packageDirectory, callback.source);
  const currentFingerprint = await withinTimeout(
    Promise.resolve().then(readCurrentInputFingerprint), timeoutMs,
    'callback input freshness check timed out',
  );
  if (currentFingerprint !== inputFingerprint) reject('callback input changed before invocation', 'PLUGIN_INPUT_STALE');

  const immutableInput = freeze(structuredClone(input));
  // Recheck App state and the full package snapshot after module loading. The
  // project profile remains the sole authority; this file is only its receipt.
  const currentReceipt = await verifyCurrent();
  const currentPlugin = assertReceipt(currentReceipt, await readRegularJson(receiptFile));
  if (currentPlugin.digest !== plugin.digest || currentPlugin.version !== plugin.version
    || await digestPackage(packageDirectory) !== plugin.digest) {
    reject('Studio Harness package binding changed before callback invocation', 'PLUGIN_BINDING_STALE');
  }
  const beforeInvokeFingerprint = await withinTimeout(
    Promise.resolve().then(readCurrentInputFingerprint), timeoutMs,
    'callback input freshness check timed out',
  );
  if (beforeInvokeFingerprint !== inputFingerprint) reject('callback input changed before invocation', 'PLUGIN_INPUT_STALE');
  let response;
  try {
    response = await executeCallbackIsolated({ packageRoot: packageDirectory, source, digest: plugin.digest, event, input: immutableInput, timeoutMs });
  } catch (error) {
    reject(`callback failed: ${error.message}`, error.code ?? 'PLUGIN_CALLBACK_FAILED');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || response.event !== event || typeof response.ok !== 'boolean') reject('callback returned a malformed response');
  if (response.ok !== true) reject(`callback rejected dispatch: ${Array.isArray(response.reasons) ? response.reasons.join('; ') : 'no reason supplied'}`, 'PLUGIN_CALLBACK_REJECTED');
  if (!equalJson(response.input, input)) reject('callback changed the original input', 'PLUGIN_CALLBACK_OUTPUT_INVALID');
  const finalFingerprint = await withinTimeout(
    Promise.resolve().then(readCurrentInputFingerprint), timeoutMs,
    'callback input freshness check timed out',
  );
  if (finalFingerprint !== inputFingerprint) reject('callback input changed during dispatch', 'PLUGIN_INPUT_STALE');
  return { ok: true, event, input };
}

async function verifyCurrentAppBinding({ projectRoot, fetchImpl, env, timeoutMs }) {
  const bindingUrl = env.STUDIO_KIT_PLUGIN_BINDINGS_URL;
  const token = env.STUDIO_KIT_PLUGIN_BINDINGS_TOKEN;
  if (typeof bindingUrl !== 'string' || !bindingUrl || typeof token !== 'string' || !token) {
    reject('Studio Kit App plugin binding API is unavailable', 'PLUGIN_BINDING_UNAVAILABLE');
  }
  let url;
  try { url = new URL(bindingUrl); } catch { reject('Studio Kit App plugin binding URL is malformed', 'PLUGIN_BINDING_UNAVAILABLE'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    || url.pathname !== '/v1/profiles/current/plugin-bindings'
    || url.username || url.password || url.hash
    || url.searchParams.size !== 1 || url.searchParams.get('projectRoot') !== projectRoot) {
    reject('Studio Kit App plugin binding URL is not bound to this project', 'PLUGIN_BINDING_UNAVAILABLE');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    reject(`Studio Kit App plugin binding request failed: ${error.message}`, 'PLUGIN_BINDING_UNAVAILABLE');
  }
  if (response.status !== 200) reject(`Studio Kit App rejected plugin binding verification with HTTP ${response.status}`, 'PLUGIN_BINDING_UNAVAILABLE');
  try { return JSON.parse(await response.text()); } catch { reject('Studio Kit App returned malformed plugin binding JSON', 'PLUGIN_BINDING_INVALID'); }
}
