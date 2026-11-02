import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCodexTaskTransport } from './codex-task.mjs';
import { observeTask, taskPackets } from './session-task.mjs';

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

export function createSessionRunner({ runtime, command, parent, launch, runtimeRpc, taskTransport, taskPrompt, pollAttempts = 30 }) {
  if (!['cmux', 'orca'].includes(runtime) || typeof command !== 'function' || typeof launch !== 'function'
    || !parent || typeof parent.sessionId !== 'string' || !parent.sessionId || typeof parent.incarnationId !== 'string' || !parent.incarnationId
    || typeof parent.cwd !== 'string' || !path.isAbsolute(parent.cwd)
    || (runtimeRpc !== undefined && typeof runtimeRpc !== 'function') || (runtime === 'orca' && typeof runtimeRpc !== 'function')) {
    throw new TypeError('session runtime requires cmux or orca, command, launch, and an exact parent identity');
  }
  parent = Object.freeze({ ...parent });
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 60) throw new TypeError('invalid observation bound');

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

  async function inspectCmux(sessionId, cwd, expectedExecutable) {
    const found = terminals(await cmux(['tree', '--all'], cwd)).filter(item => item.id === sessionId);
    if (found.length !== 1 || found[0].type !== 'terminal' || typeof found[0].tty !== 'string' || !/^[A-Za-z0-9/]+$/.test(found[0].tty)) throw invalid('cmux terminal is missing or ambiguous');
    const target = found[0];
    const foreground = async () => {
      const processes = await invoke('ps', ['-t', target.tty, '-o', 'pid=,pgid=,tpgid=,comm='], cwd);
      const rows = processes.trim().split('\n').map(line => {
        const [pid, pgid, tpgid, ...command] = line.trim().split(/\s+/);
        return { pid: Number(pid), pgid: Number(pgid), tpgid: Number(tpgid), executable: command.join(' ') };
      });
      const leaders = rows.filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid === row.pgid && row.pid === row.tpgid);
      if (leaders.length !== 1) throw invalid('cmux foreground process is missing or ambiguous');
      const leader = leaders[0];
      const candidates = expectedExecutable === undefined ? leaders : rows.filter(row =>
        Number.isSafeInteger(row.pid) && row.pid > 0 && row.pgid === leader.pid && row.tpgid === leader.pid
        && path.basename(row.executable) === path.basename(expectedExecutable));
      if (candidates.length !== 1 || !candidates[0].executable) throw invalid('configured worker executable is missing or ambiguous');
      return { ...candidates[0], leader: leader.pid };
    };
    const observed = await foreground();
    const pid = String(observed.pid);
    const started = (await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim();
    if (!started) throw invalid('cmux foreground incarnation is unavailable');
    const directory = async () => {
      const paths = (await invoke('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], cwd))
        .split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
      if (paths.length !== 1 || paths[0] !== cwd) throw invalid('cmux foreground cwd differs from successor cwd');
      return paths[0];
    };
    await directory();
    const confirmed = terminals(await cmux(['tree', '--all'], cwd)).filter(item => item.id === sessionId);
    const current = await foreground();
    await directory();
    const confirmedStart = (await invoke('ps', ['-p', pid, '-o', 'lstart='], cwd)).trim();
    if (confirmed.length !== 1 || confirmed[0].type !== 'terminal' || confirmed[0].tty !== target.tty
      || confirmed[0].workspaceId !== target.workspaceId || confirmed[0].windowId !== target.windowId
      || confirmedStart !== started || JSON.stringify(current) !== JSON.stringify(observed)) throw invalid('cmux terminal changed during observation');
    return { sessionId, cwd, incarnationId: `${target.tty}:${pid}:${started}`, executable: observed.executable, pid: observed.pid, tty: target.tty, runtime, workspaceId: target.workspaceId };
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
    return { sessionId: terminal.handle, cwd: paths[0], incarnationId: terminal.incarnationId, executable, pid: foreground.pid, tty, runtime, worktreeId: terminal.worktreeId };
  }

  const inspect = runtime === 'cmux' ? inspectCmux : inspectOrca;
  const transportFor = executable => taskTransport ?? (path.basename(executable) === 'codex' ? createCodexTaskTransport({ command, executable }) : null);
  async function workerIdentity(worker) {
    const transport = transportFor(worker.executable);
    if (typeof transport?.identity !== 'function') throw invalid('worker identity provider is unavailable');
    const identity = await transport.identity(worker);
    if (typeof identity?.threadId !== 'string' || !identity.threadId) throw invalid('native worker identity is unavailable');
    return { ...worker, threadId: identity.threadId };
  }

  async function findStarted(input) {
    const { args, key } = input;
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
    const argv = await launch(args);
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !argv[0]) throw invalid('configured worker executable is missing');
    const observed = await inspect(matches[0], args.cwd, argv[0]);
    if (!observed.executable
      || path.basename(observed.executable) !== path.basename(argv[0])) throw invalid('configured worker executable has not started');
    const packets = await taskPackets(args);
    const prompt = taskPrompt ? await taskPrompt(args, argv) : argv.at(-1);
    const transport = transportFor(argv[0]);
    const result = await observeTask({ transport, observed, input, prompt, packets, submit: true });
    if (JSON.stringify(await inspect(matches[0], args.cwd, argv[0])) !== JSON.stringify(observed)) throw invalid('worker changed during task observation');
    return result;
  }

  async function deliver(input, submission) {
    const { recipient } = input.args;
    if (!recipient || recipient.sessionId === parent.sessionId) throw invalid('result recipient must be distinct from the closing owner');
    const observed = await inspect(recipient.sessionId, recipient.cwd, recipient.executable);
    if (observed.incarnationId !== recipient.incarnationId) throw invalid('result recipient incarnation changed');
    const packets = await taskPackets(input.args);
    const prompt = `Receive the completed work result and continue its authorized next action.\n${packets.map(packet => `${packet.path}\n${packet.digest}\n${packet.content}`).join('\n')}`;
    const workerTransport = transportFor(observed.executable);
    const transport = workerTransport && { ...workerTransport, async submit(request) {
      if (!submission || submission.attempted) throw invalid('result submission is uncertain; observation only');
      submission.attempted = true;
      return workerTransport.submit(request);
    } };
    const result = await observeTask({ transport, observed, input, prompt, packets, submit: Boolean(submission) && !submission.attempted });
    if (JSON.stringify(await inspect(recipient.sessionId, recipient.cwd, recipient.executable)) !== JSON.stringify(observed)) throw invalid('recipient changed during delivery');
    return result;
  }

  async function close(input, verifyOnly) {
    const { owner, recipient } = input.args;
    if (parent.closable !== true || !owner || !recipient || owner.sessionId !== parent.sessionId || owner.incarnationId !== parent.incarnationId
      || owner.cwd !== parent.cwd || owner.sessionId === recipient.sessionId || !owner.worker?.executable || !owner.worker.incarnationId || !owner.worker.threadId) throw invalid('session close ownership is not authorized');
    const callerTty = (await invoke('ps', ['-p', String(process.pid), '-o', 'tty='], owner.cwd)).trim();
    if (!callerTty || callerTty === owner.tty) throw invalid('session close requires a surviving external supervisor');
    const present = runtime === 'cmux'
      ? terminals(await cmux(['tree', '--all'], owner.cwd)).filter(item => item.id === owner.sessionId)
      : (await orca(['terminal', 'list', '--worktree', `path:${owner.cwd}`], owner.cwd)).terminals.filter(item => item.handle === owner.sessionId);
    if (present.length === 0 && verifyOnly) return { sessionId: owner.sessionId, incarnationId: owner.incarnationId, closed: true };
    if (present.length !== 1) throw invalid('close target is missing or ambiguous');
    const receiver = await inspect(recipient.sessionId, recipient.cwd, recipient.executable);
    if (receiver.incarnationId !== recipient.incarnationId) throw invalid('result recipient changed before close');
    const current = await inspect(owner.sessionId, owner.cwd, parent.workerExecutable);
    const worker = await workerIdentity(await inspect(owner.sessionId, owner.cwd, owner.worker.executable));
    if (current.incarnationId !== owner.incarnationId || worker.incarnationId !== owner.worker.incarnationId
      || worker.pid !== owner.worker.pid || worker.executable !== owner.worker.executable || worker.threadId !== owner.worker.threadId) throw invalid('close target identity changed');
    if (verifyOnly) return { sessionId: owner.sessionId, incarnationId: owner.incarnationId, closed: false };
    if (runtime === 'cmux') {
      const inventory = terminals(await cmux(['tree', '--all'], owner.cwd));
      const owned = inventory.filter(item => item.workspaceId === current.workspaceId);
      const target = inventory.filter(item => item.id === owner.sessionId);
      if (target.length !== 1 || target[0].workspaceId !== current.workspaceId || target[0].tty !== current.tty) throw invalid('close target moved before mutation');
      // Keep an exited placeholder when needed: workspace-wide close has no atomic inventory fence.
      if (owned.length === 1 && owned[0].id === owner.sessionId) {
        await invoke('cmux', ['new-surface', '--workspace', current.workspaceId, '--type', 'terminal', '--command', '/usr/bin/true', '--focus', 'false'], owner.cwd);
        const after = await workerIdentity(await inspect(owner.sessionId, owner.cwd, owner.worker.executable));
        if (after.incarnationId !== owner.worker.incarnationId || after.threadId !== owner.worker.threadId || after.workspaceId !== current.workspaceId) throw invalid('owner changed while preparing surface closure');
      }
      await invoke('cmux', ['close-surface', '--workspace', current.workspaceId, '--surface', owner.sessionId], owner.cwd);
    }
    else await orca(['terminal', 'close', '--terminal', owner.sessionId], owner.cwd);
    return close(input, true);
  }

  async function poll(action) {
    let failure;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      try { return await action(); } catch (error) { failure = error; }
      if (attempt + 1 < pollAttempts) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw failure;
  }

  return Object.freeze({
    contractVersion: 'harness.session-adapter/1',
    capabilities: ['fix-forward', 'failure-classification-five-way', 'retry-limit', 'ops-e0-only', 'policy-review'],
    async observe({ cwd, targetCwd = cwd, recipient }) {
      if (recipient) {
        if (recipient.sessionId === parent.sessionId || !recipient.executable || !recipient.incarnationId) throw invalid('invalid return recipient');
        const observed = await inspect(recipient.sessionId, recipient.cwd, recipient.executable);
        if (observed.incarnationId !== recipient.incarnationId) throw invalid('return recipient changed');
        return observed;
      }
      if (cwd !== parent.cwd || !path.isAbsolute(targetCwd)) throw invalid('parent or successor cwd is invalid');
      if (runtime === 'cmux') {
        const identity = await cmux(['identify'], cwd);
        if (identity.caller?.surface_id !== parent.sessionId) throw invalid('cmux caller is not the configured parent');
      } else if (process.env.ORCA_TERMINAL_HANDLE !== parent.sessionId) {
        throw invalid('Orca caller is not the configured parent');
      }
      const target = (await invoke('pwd', ['-P'], targetCwd)).trim();
      if (target !== targetCwd) throw invalid('successor directory does not match the exact target cwd');
      const current = await inspect(parent.sessionId, cwd, parent.workerExecutable);
      if (current.incarnationId !== parent.incarnationId) throw invalid('parent incarnation changed');
      const executable = parent.workerExecutable;
      const worker = executable ? await workerIdentity(await inspect(parent.sessionId, cwd, executable)) : undefined;
      return { ...current, targetCwd: target, ...(worker ? { worker } : {}), closable: parent.closable === true };
    },
    async execute(input) {
      if (input.effect === 'session.deliver') { const submission = {}; return poll(() => deliver(input, submission)); }
      if (input.effect === 'session.close') return close(input, false);
      if (input.effect !== 'session.start' || !path.isAbsolute(input.args?.cwd ?? '')) throw invalid('unsupported session effect');
      const argv = await launch(input.args);
      if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value || value.includes('\0'))) throw invalid('launch must return a nonempty argument vector');
      const text = `cd -- ${quote(input.args.cwd)} && exec ${argv.map(quote).join(' ')}`;
      if (runtime === 'cmux') {
        // Mutation acknowledgments can be plain text; completion requires live observation below.
        await invoke('cmux', ['--json', '--id-format', 'uuids', 'new-workspace', '--name', marker(input.key), '--cwd', input.args.cwd, '--command', text, '--focus', 'false'], input.args.cwd);
      } else {
        await orca(['terminal', 'create', '--worktree', `path:${input.args.cwd}`, '--title', marker(input.key), '--command', text], input.args.cwd);
      }
      return poll(() => findStarted(input));
    },
    async verify(input) {
      try {
        const result = await (input.effect === 'session.close' ? close(input, true) : input.effect === 'session.deliver' ? deliver(input) : findStarted(input));
        return { status: input.effect === 'session.close' && !result.closed ? 'not-applied' : 'completed', result };
      }
      catch (error) { return { status: 'unknown', verify: { code: error.code ?? 'SESSION_OBSERVATION_INVALID', message: error.message } }; }
    },
  });
}
