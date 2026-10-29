import { createHash } from 'node:crypto';
import path from 'node:path';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'SESSION_OBSERVATION_INVALID' });
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function terminals(tree) {
  return (tree.windows ?? []).flatMap(window => (window.workspaces ?? []).flatMap(workspace =>
    (workspace.panes ?? []).flatMap(pane => (pane.surfaces ?? []).map(surface => ({ ...surface, workspaceId: workspace.id, windowId: window.id })))));
}

export function createSessionRunner({ runtime, command, parent, launch, runtimeRpc }) {
  if (!['cmux', 'orca'].includes(runtime) || typeof command !== 'function' || typeof launch !== 'function'
    || !parent || typeof parent.sessionId !== 'string' || !parent.sessionId || typeof parent.incarnationId !== 'string' || !parent.incarnationId
    || typeof parent.cwd !== 'string' || !path.isAbsolute(parent.cwd)
    || (runtimeRpc !== undefined && typeof runtimeRpc !== 'function') || (runtime === 'orca' && typeof runtimeRpc !== 'function')) {
    throw new TypeError('session runtime requires cmux or orca, command, launch, and an exact parent identity');
  }
  parent = Object.freeze({ ...parent });

  async function invoke(binary, args, cwd) {
    const result = await command(binary, args, { cwd });
    if (result.exitCode !== 0 || result.signal) throw invalid(`${binary} observation or launch failed`);
    return result.stdout;
  }

  async function json(binary, args, cwd) {
    let value;
    try { value = JSON.parse(await invoke(binary, args, cwd)); }
    catch (cause) { throw invalid(`invalid ${binary} runtime response: ${cause.message}`); }
    if (!value || typeof value !== 'object' || value.ok === false) throw invalid(`${binary} runtime rejected request`);
    return value.result ?? value;
  }

  const cmux = (args, cwd) => json('cmux', ['--json', '--id-format', 'uuids', ...args], cwd);
  const orca = (args, cwd) => json('orca', [...args, '--json'], cwd);
  const marker = key => `handoff-${createHash('sha256').update(key).digest('hex')}`;

  async function inspectCmux(sessionId, cwd) {
    const found = terminals(await cmux(['tree', '--all'], cwd)).filter(item => item.id === sessionId && item.type === 'terminal');
    if (found.length !== 1 || typeof found[0].tty !== 'string' || !/^[A-Za-z0-9/]+$/.test(found[0].tty)) throw invalid('cmux terminal is missing or ambiguous');
    const target = found[0];
    const processes = await invoke('ps', ['-t', target.tty, '-o', 'pid=,pgid=,tpgid='], cwd);
    const rows = processes.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const leaders = rows.filter(([pid, pgid, tpgid]) => Number.isSafeInteger(pid) && pid > 0 && pid === pgid && pid === tpgid);
    if (leaders.length !== 1) throw invalid('cmux foreground process is missing or ambiguous');
    const pid = String(leaders[0][0]);
    const observed = await invoke('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], cwd);
    const directories = observed.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    if (directories.length !== 1 || directories[0] !== cwd) throw invalid('cmux foreground cwd differs from successor cwd');
    const started = (await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim();
    if (!started) throw invalid('cmux foreground incarnation is unavailable');
    const confirmed = terminals(await cmux(['tree', '--all'], cwd)).filter(item => item.id === sessionId && item.tty === target.tty);
    const confirmedStart = (await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim();
    const foreground = await invoke('ps', ['-t', target.tty, '-o', 'pid=,pgid=,tpgid='], cwd);
    const sameLeader = foreground.trim().split('\n').map(line => line.trim().split(/\s+/))
      .filter(([processId, pgid, tpgid]) => processId === pgid && processId === tpgid);
    if (confirmed.length !== 1 || confirmedStart !== started || sameLeader.length !== 1 || sameLeader[0][0] !== pid) throw invalid('cmux terminal changed during observation');
    const executable = (await invoke('ps', ['-p', pid, '-o', 'comm='], cwd)).trim();
    if (!executable) throw invalid('cmux foreground executable is unavailable');
    return { sessionId, cwd: directories[0], incarnationId: `${target.tty}:${pid}:${started}`, executable, runtime, workspaceId: target.workspaceId };
  }

  async function inspectOrca(sessionId, cwd) {
    const { terminal } = await orca(['terminal', 'show', '--terminal', sessionId], cwd);
    if (terminal?.handle !== sessionId || !terminal.incarnationId || terminal.orphaned === true || terminal.executionHostId !== 'local'
      || terminal.connected !== true || terminal.writable !== true) {
      throw invalid('Orca terminal identity is unavailable');
    }
    const processEvidence = async () => {
      const requestedAt = performance.now();
      const response = await runtimeRpc('terminal.inspectProcess', { terminal: sessionId, expectedIncarnationId: terminal.incarnationId, scanChildProcesses: true });
      const receiveDelay = Math.max(0, performance.now() - requestedAt);
      if (response?.ok === false) throw invalid('Orca process inspection failed');
      const evidence = (response?.result ?? response)?.process?.foregroundProcessEvidence;
      const fence = evidence?.fence;
      if (evidence?.verdict !== 'live' || evidence.ptyId !== sessionId || evidence.ptyIncarnationId !== terminal.incarnationId
        || typeof evidence.authorityGeneration !== 'string' || !evidence.authorityGeneration || evidence.authorityGeneration.length > 256
        || !Number.isSafeInteger(evidence.observationEpoch) || evidence.observationEpoch < 0
        || !Number.isSafeInteger(evidence.capturedAgeMs) || evidence.capturedAgeMs < 0 || Math.max(evidence.capturedAgeMs, receiveDelay) > 2000
        || fence?.platform !== 'posix' || !Number.isSafeInteger(fence.process?.pid) || fence.process.pid < 1
        || !Number.isSafeInteger(fence.shellPid) || fence.shellPid < 1 || typeof fence.shellStartTime !== 'string' || !fence.shellStartTime
        || typeof fence.process.startTime !== 'string' || !fence.process.startTime
        || typeof fence.tty !== 'string' || !fence.tty || !Number.isSafeInteger(fence.foregroundPgid) || fence.foregroundPgid < 1) {
        throw invalid('Orca foreground process evidence is incomplete or stale');
      }
      return evidence;
    };
    const evidence = await processEvidence();
    const { process: foreground, tty, foregroundPgid } = evidence.fence;
    const pid = String(foreground.pid);
    const started = (await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim();
    const metadata = (await invoke('ps', ['-p', pid, '-o', 'tty=,pgid=,comm='], cwd)).trim().split(/\s+/);
    if (started !== foreground.startTime || metadata[0] !== tty || Number(metadata[1]) !== foregroundPgid) throw invalid('Orca OS process identity differs from native evidence');
    const executable = metadata.slice(2).join(' ');
    if (!executable) throw invalid('Orca foreground executable is unavailable');
    const paths = (await invoke('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], cwd)).split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    if (paths.length !== 1 || paths[0] !== cwd) throw invalid('Orca foreground process cwd differs from the requested target');
    const after = await processEvidence();
    if (after.authorityGeneration !== evidence.authorityGeneration || after.observationEpoch <= evidence.observationEpoch
      || JSON.stringify(after.fence) !== JSON.stringify(evidence.fence)) throw invalid('Orca foreground process changed during observation');
    if ((await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim() !== started) throw invalid('Orca OS process incarnation changed');
    const confirmed = (await orca(['terminal', 'show', '--terminal', sessionId], cwd)).terminal;
    if (confirmed?.handle !== sessionId || confirmed.incarnationId !== terminal.incarnationId || confirmed.worktreePath !== terminal.worktreePath
      || confirmed.connected !== true || confirmed.writable !== true || confirmed.orphaned === true) throw invalid('Orca terminal changed during observation');
    return { sessionId: terminal.handle, cwd: paths[0], incarnationId: terminal.incarnationId, executable, runtime, worktreeId: terminal.worktreeId };
  }

  const inspect = runtime === 'cmux' ? inspectCmux : inspectOrca;

  async function findStarted({ args, key }) {
    const title = marker(key);
    let matches;
    if (runtime === 'cmux') {
      const tree = await cmux(['tree', '--all'], args.cwd);
      const workspaces = (tree.windows ?? []).flatMap(window => window.workspaces ?? []).filter(item => item.title === title);
      matches = workspaces.flatMap(workspace => (workspace.panes ?? []).flatMap(pane => pane.surfaces ?? [])).filter(item => item.type === 'terminal').map(item => item.id);
    } else {
      const result = await orca(['terminal', 'list', '--worktree', `path:${args.cwd}`], args.cwd);
      matches = (result.terminals ?? []).filter(item => item.title === title).map(item => item.handle);
    }
    if (matches.length !== 1 || matches[0] === parent.sessionId) throw invalid('successor target is missing or ambiguous');
    const observed = await inspect(matches[0], args.cwd);
    const argv = await launch(args);
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !observed.executable
      || path.basename(observed.executable) !== path.basename(argv[0])) throw invalid('configured worker executable has not started');
    return observed;
  }

  return Object.freeze({
    contractVersion: 'harness.session-adapter/1',
    capabilities: ['fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review'],
    async observe({ cwd, targetCwd = cwd }) {
      if (cwd !== parent.cwd || !path.isAbsolute(targetCwd)) throw invalid('parent or successor cwd is invalid');
      if (runtime === 'cmux') {
        const identity = await cmux(['identify'], cwd);
        if (identity.caller?.surface_id !== parent.sessionId) throw invalid('cmux caller is not the configured parent');
      } else if (process.env.ORCA_TERMINAL_HANDLE !== parent.sessionId) {
        throw invalid('Orca caller is not the configured parent');
      }
      const target = (await invoke('pwd', ['-P'], targetCwd)).trim();
      if (target !== targetCwd) throw invalid('successor directory does not match the exact target cwd');
      const current = await inspect(parent.sessionId, cwd);
      if (current.incarnationId !== parent.incarnationId) throw invalid('parent incarnation changed');
      return { ...current, targetCwd: target };
    },
    async execute(input) {
      if (input.effect !== 'session.start' || !path.isAbsolute(input.args?.cwd ?? '')) throw invalid('unsupported session effect');
      const argv = await launch(input.args);
      if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value || value.includes('\0'))) throw invalid('launch must return a nonempty argument vector');
      const text = `cd -- ${quote(input.args.cwd)} && exec ${argv.map(quote).join(' ')}`;
      if (runtime === 'cmux') {
        await cmux(['new-workspace', '--name', marker(input.key), '--cwd', input.args.cwd, '--command', text, '--focus', 'false'], input.args.cwd);
      } else {
        await orca(['terminal', 'create', '--worktree', `path:${input.args.cwd}`, '--title', marker(input.key), '--command', text], input.args.cwd);
      }
      return findStarted(input);
    },
    async verify(input) {
      try { return { status: 'completed', result: await findStarted(input) }; }
      catch { return { status: 'unknown' }; }
    },
  });
}
