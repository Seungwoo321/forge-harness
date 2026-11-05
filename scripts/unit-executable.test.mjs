import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const runtimeModule = new URL('./lib/session-runtime.mjs', import.meta.url).href;
const fields = { title: 'Completed work', objective: 'complete work', acceptance: 'AC-1 passes', tracking: 'none', decision: 'approved successor', changed: 'src/main.mjs', verification: 'tests pass', remainingRisk: 'none', nextFirstAction: 'read packet' };
const packet = ['목표: finish', '수용 기준: AC-1', '작업관리: none', '결정: approved', '변경: src/main.mjs', '검증: tests', '남은 일·위험: none', '다음 단위 첫 행동: read packet'].join('\n');

async function fixture(t, { state = 'Delivered', runtime = null, mode = 'success', separate = false, managed = false, managedProvider = 'codex' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'unit-executable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product checkout');
  const parentCwd = separate ? path.join(root, 'coordinator') : cwd;
  const bin = path.join(root, 'bin');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'gate.mjs'), 'console.log(JSON.stringify({ok:true,covers:["AC-1"]}))');
  await mkdir(bin);
  if (separate) await mkdir(parentCwd);
  const stateRoot = path.join(root, 'state');
  const store = createUnitStateStore(stateRoot);
  await store.create({ schema: 'harness.unit/1', unit: 'unit-a', revision: 0, kind: 'impl', state,
    request: 'work', tracker: null, policy: { goal: { class: 'product-prelaunch' }, delivery: 'none', review: { mode: 'none', by: 'session', triggers: [] } },
    accepted: state === 'SelfGated' ? null : { head: 'head-1', contentFingerprint: 'fp-1' },
    acceptance: [{ id: 'AC-1', status: 'open' }], stages: [], evidence: [], openDecisions: [],
  });
  const trace = path.join(root, 'trace.ndjson');
  const nativeState = path.join(root, 'native.json');
  await writeFile(nativeState, JSON.stringify({ child: false }));
  const request = path.join(root, 'finish.json');
  const incarnationId = runtime === 'cmux' ? 'ttys1:101:START' : 'parent-incarnation';
  await writeFile(request, JSON.stringify({ resultFields: fields, handoffContent: packet,
    successor: { approved: true, unit: 'unit-next', cwd },
    parentRuntime: { sessionId: 'parent', cwd: parentCwd, incarnationId }, requestedDelivery: 'none',
  }));
  const providers = path.join(root, 'adapters.mjs');
  await writeFile(providers, `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createSessionRunner } from ${JSON.stringify(runtimeModule)};
import { taskDigest } from ${JSON.stringify(new URL('./lib/session-task.mjs', import.meta.url).href)};
export async function createRuntimeAdapters({cwd,adapters}) {
  const trace = x => appendFile(process.env.TEST_TRACE, JSON.stringify(x)+'\\n');
  const parentCwd = process.env.TEST_PARENT;
  const mode = process.env.TEST_MODE;
  const receipt = input => { const identity={sessionId:'child',incarnationId:'child-incarnation',cwd:input.args.cwd,executable:'worker'}; return {...identity,task:{schema:'harness.task-receipt/1',effectKey:input.key,...identity,promptDigest:taskDigest('native prompt'),threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets:['handoff','result'].filter(name=>input.args[name+'Path']).map(name=>({path:input.args[name+'Path'],digest:input.args[name+'Digest']}))}}};
  const sessionRunner = process.env.TEST_RUNTIME ? createSessionRunner({runtime:process.env.TEST_RUNTIME,command:adapters.command,pollAttempts:1,
    taskTransport:{async identity() { const state=JSON.parse(await readFile(process.env.TEST_NATIVE)); return {threadId:/--session-id' '([^']+)'/.exec(state.command ?? '')?.[1] ?? 'thread'}; }, async observe({prompt,packets}) {return {state:'started',promptDigest:taskDigest(prompt),threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets}}},
    parent:{sessionId:'parent',incarnationId:${JSON.stringify(incarnationId)},cwd:parentCwd},launch:args=>['worker','--unit',args.unit],
    async runtimeRpc(method,params){const result=await adapters.command('orca-rpc',[method,JSON.stringify(params)],{cwd});if(result.exitCode!==0)throw Error('RPC failed');return JSON.parse(result.stdout)}}) : {
    contractVersion:'harness.session-adapter/1',capabilities:['fix-forward','failure-classification-five-way','retry-limit','ops-e0-only','policy-review'],
    async observe(input){await trace({event:'observe',...input});const observations=(await readFile(process.env.TEST_TRACE,'utf8')).trim().split('\\n').map(JSON.parse).filter(row=>row.event==='observe').length;return {sessionId:mode==='wrong-parent'||(mode==='late-parent'&&observations>1)?'wrong':'parent',cwd:mode==='wrong-parent-cwd'?cwd:parentCwd,incarnationId:${JSON.stringify(incarnationId)},targetCwd:mode==='wrong-target'?'wrong':input.targetCwd,...(mode==='finalize'?{closable:true,tty:'tty-owner',worker:{incarnationId:'owner-worker',pid:42,executable:'worker',threadId:'owner-thread'}}:{})}},
    async execute(input){await trace({event:'execute',...input});if(mode==='finalize'){if(input.effect==='session.close'){await writeFile(process.env.TEST_NATIVE,JSON.stringify({closed:true}));return {closed:true,sessionId:'parent',incarnationId:${JSON.stringify(incarnationId)}}}return receipt(input)}if(mode==='uncertain')throw Error('lost response');return {sessionId:'child',cwd:mode==='wrong-child'?'wrong':input.args.cwd}},
    async verify(input){await trace({event:'verify',...input});if(mode==='finalize'&&input.effect==='session.close'&&JSON.parse(await readFile(process.env.TEST_NATIVE,'utf8')).closed)return {status:'completed',result:{closed:true,sessionId:'parent',incarnationId:${JSON.stringify(incarnationId)}}};return {status:'unknown'}}
  };
  return {sessionRunner,git:{async inspectUnit({record}) {await trace({event:'inspect',state:record.state,cwd});const inspections=(await readFile(process.env.TEST_TRACE,'utf8')).trim().split('\\n').map(JSON.parse).filter(row=>row.event==='inspect').length;return {head:'head-1',contentFingerprint:mode==='changed'||(mode==='late-close-change'&&inspections>=3)?'changed':'fp-1'}}},
    gates:{async describe(id){await trace({event:'describe',id,cwd});return {id,command:[process.execPath,'gate.mjs'],files:[{path:'gate.mjs',content:await readFile(cwd+'/gate.mjs','utf8')}],format:'exec',resultFormat:'json',reportPath:'reports/'+id+'.json'}},
      async run(gate){await trace({event:'gate',id:gate.id,cwd});return {exit:0,ok:true,covers:['AC-1'],report:'{}',reportPath:gate.reportPath,verdict:'green',path:gate.reportPath,key:'original:'+gate.id}}}};
}`);
  if (runtime) {
    const stub = path.join(bin, 'native.mjs');
    await writeFile(stub, `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import path from 'node:path';
const binary=path.basename(process.argv[1]);const args=process.argv.slice(2);
appendFileSync(process.env.TEST_TRACE,JSON.stringify({binary,args,cwd:process.cwd()})+'\\n');
let s=JSON.parse(readFileSync(process.env.TEST_NATIVE));const child=s.child;
const output=x=>process.stdout.write(JSON.stringify(x));
if(binary==='ps'){
 const child=args.includes('202')||args.includes('203')||args.includes('ttys2');const mode=process.env.TEST_MODE;
 if(args.includes('pid=,pgid=,tpgid=,comm=')){
  if(child){s.scans=(s.scans??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s))}
  let rows=child?('202 202 202 '+(process.env.TEST_MANAGED?process.env.TEST_PROVIDER:'worker')+'\\n'):'101 101 101 worker\\n';
  if(child&&mode.startsWith('wrapped')){
   rows='202 202 202 /usr/bin/login\\n203 202 202 /bin/worker\\n';
   if(mode==='wrapped-mismatch')rows=rows.replace('/bin/worker','/bin/shell');
   if(mode==='wrapped-background')rows=rows.replace('203 202 202','203 203 202');
   if(mode==='wrapped-ambiguous'||(mode==='wrapped-late-ambiguous'&&s.scans>1))rows+='204 202 202 /bin/worker\\n';
   if(mode==='wrapped-changed'&&s.scans>1)rows=rows.replace('203 202 202','204 202 202');
   if(mode==='wrapped-exec-changed'&&s.scans>1)rows=rows.replace('/bin/worker','/other/worker');
  }
  process.stdout.write(rows);
 }else if(args.includes('lstart=')){
  if(child){s.starts=(s.starts??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s))}
  process.stdout.write(child&&mode==='wrapped-reused'&&s.starts>1?'CHANGED\\n':'START\\n');
 }else process.stdout.write(args.includes('tty=,pgid=,comm=')?(child?('ttys2 202 '+(process.env.TEST_MANAGED?process.env.TEST_PROVIDER:'worker')+'\\n'):'ttys1 101 worker\\n'):'worker\\n');
}
else if(binary==='lsof'){
 const child=args.includes('202')||args.includes('203');const mode=process.env.TEST_MODE;
 if(child){s.directories=(s.directories??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s))}
 const wrong=child&&(mode==='native-wrong-child'||mode==='wrapped-wrong-cwd'||(mode==='wrapped-cwd-changed'&&s.directories>1));
 process.stdout.write('p1\\nn'+(wrong?'/wrong':process.cwd())+'\\n');
}
else if(binary==='orca-rpc'){
 const params=JSON.parse(args[1]);const child=params.terminal==='child';
 s.epoch=(s.epoch??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));
 const evidence={authorityGeneration:'generation-1',observationEpoch:s.epoch,capturedAgeMs:0,ptyId:params.terminal,ptyIncarnationId:params.expectedIncarnationId,verdict:'live',processName:child&&process.env.TEST_MANAGED?process.env.TEST_PROVIDER:'worker',fence:{platform:'posix',shellPid:1,shellStartTime:'START',tty:child?'ttys2':'ttys1',foregroundPgid:child?202:101,process:{pid:child?202:101,startTime:'START'}}};
 if(process.env.TEST_MODE==='native-no-process')evidence.verdict='unknown';
 if(process.env.TEST_MODE==='native-stale')evidence.capturedAgeMs=2001;
 if(child&&process.env.TEST_MODE==='native-process-changed'){s.inspections=(s.inspections??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));if(s.inspections>1)evidence.fence.process.startTime='CHANGED'}
 output({ok:true,result:{process:{foregroundProcessEvidence:evidence}}});
}
else if(binary==='cmux'){
 if(args.includes('identify'))output({caller:{surface_id:'parent'}});
 else if(args.includes('new-workspace')){s.child=true;s.title=args[args.indexOf('--name')+1];writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));process.stdout.write('OK workspace:42\\n');if(process.env.TEST_MODE==='wrapped-lost-response')process.exitCode=1}
 else {
  if(child){s.trees=(s.trees??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s))}
  const mode=process.env.TEST_MODE;
  const duplicate=child&&((mode==='wrapped-terminal-duplicate-initial'&&s.trees>=2)||((mode==='wrapped-terminal-duplicate-confirmed'||mode==='wrapped-terminal-type-duplicate')&&s.trees>=3));
  const extra=duplicate?[{id:'child',type:mode==='wrapped-terminal-type-duplicate'?'browser':'terminal',tty:'ttys3'}]:[];
  output({windows:[{id:'window',workspaces:[{id:'parent-workspace',title:'parent',panes:[{surfaces:[{id:'parent',type:'terminal',tty:'ttys1'}]}]},...(child?[{id:'child-workspace',title:s.title,panes:[{surfaces:[{id:'child',type:'terminal',tty:'ttys2'},...extra]}]}]:[])]}]});
 }
} else {
 const terminal=id=>({handle:id,incarnationId:id+'-incarnation',worktreePath:id==='parent'?'/registered/coordinator-root':process.env.TEST_PRODUCT,connected:true,writable:true,orphaned:id==='child'&&process.env.TEST_MODE==='native-orphan',title:['native-title-changed','native-orphan'].includes(process.env.TEST_MODE)?'renamed':s.title,worktreeId:'worktree',executionHostId:'local'});
 if(args.includes('create')){s.child=true;s.title=args[args.indexOf('--title')+1];s.command=args[args.indexOf('--command')+1];writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));output({ok:true,result:{terminal:terminal('child')}})}
 else if(args.includes('list'))output({ok:true,result:{terminals:child?[terminal('child')]:[]}});
 else output({ok:true,result:{terminal:terminal(args[args.indexOf('--terminal')+1])}});
}
`);
    for (const name of [runtime, 'ps', 'lsof', 'orca-rpc']) {
      const file = path.join(bin, name);
      await writeFile(file, await readFile(stub));
      await chmod(file, 0o755);
    }
  }
  const run = command => {
    const process = spawnSync(globalThis.process.execPath, [cli, 'unit', command, 'unit-a', '--adapters', providers, '--state-root', stateRoot, '--project-root', cwd, ...(command === 'finish' ? ['--request', request] : [])], {
      cwd, encoding: 'utf8', env: { ...globalThis.process.env, PATH: `${bin}${path.delimiter}${globalThis.process.env.PATH}`, ORCA_TERMINAL_HANDLE: 'parent', TEST_TRACE: trace, TEST_NATIVE: nativeState, TEST_RUNTIME: runtime ?? '', TEST_MODE: mode, TEST_PARENT: parentCwd, TEST_PRODUCT: cwd, TEST_MANAGED: managed ? '1' : '', TEST_PROVIDER: managedProvider },
    });
    const line = process.stdout.trim().split('\n').at(-1);
    assert.match(line ?? '', /^RESULT /, process.stderr);
    return { ...JSON.parse(line.slice(7)), status: process.status };
  };
  const rows = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const ledger = () => createLedgerStore(stateRoot).withLock('unit-a', entries => entries.read());
  return { root, cwd, parentCwd, stateRoot, store, request, providers, run, rows, ledger };
}

test('public executable rejects process-only generic runner completion', async t => {
  const f = await fixture(t);
  assert.equal(f.run('finish').code, 3);
  const rows = await f.rows();
  assert.equal(rows[0].cwd, f.cwd);
  assert.equal(rows.find(row => row.event === 'execute').args.cwd, f.cwd);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});

for (const mode of ['wrong-parent', 'wrong-parent-cwd', 'wrong-target']) {
  test(`public executable rejects ${mode} before session start`, async t => {
    const f = await fixture(t, { mode, separate: true });
    assert.equal(f.run('finish').code, 1);
    assert.equal((await f.rows()).some(row => row.event === 'execute'), false);
    assert.equal((await f.ledger()).length, 0);
    assert.equal((await f.store.read('unit-a')).state, 'Delivered');
  });
}

test('public executable preserves uncertain intent and never relaunches during reconciliation', async t => {
  const f = await fixture(t, { mode: 'uncertain' });
  assert.equal(f.run('finish').code, 3);
  assert.equal(f.run('finish').code, 3);
  assert.equal((await f.rows()).filter(row => row.event === 'execute').length, 1);
  assert.equal((await f.rows()).filter(row => row.event === 'verify').length, 1);
  assert.equal((await f.ledger()).filter(row => row.event === 'intent').length, 1);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});

test('wrong worker cwd preserves unresolved intent and cannot close or relaunch', async t => {
  const f = await fixture(t, { mode: 'wrong-child', separate: true });
  assert.equal(f.run('finish').code, 3);
  assert.equal(f.run('finish').code, 3);
  assert.equal((await f.rows()).filter(row => row.event === 'execute').length, 1);
  assert.deepEqual((await f.ledger()).map(row => row.event), ['intent', 'verification']);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});

test('parent identity is rechecked after preparation immediately before launch', async t => {
  const f = await fixture(t, { mode: 'late-parent', separate: true });
  assert.equal(f.run('finish').code, 3);
  assert.equal((await f.rows()).some(row => row.event === 'execute'), false);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});

for (const runtime of ['cmux', 'orca']) {
  test(`public executable uses native ${runtime} commands with distinct parent and target cwd`, async t => {
    const f = await fixture(t, { runtime, state: 'Accepted', separate: true });
    const result = f.run('finish');
    assert.equal(result.code, 3, JSON.stringify(result));
    const rows = await f.rows();
    const started = rows.find(row => row.binary === runtime && row.args.includes(runtime === 'cmux' ? 'new-workspace' : 'create'));
    assert.equal(started.cwd, f.cwd);
    assert.ok(started.args.some(arg => arg.includes(f.cwd)));
    assert.ok(rows.some(row => row.binary === runtime && row.cwd === f.parentCwd));
    assert.deepEqual(rows.filter(row => row.event === 'inspect').map(row => row.state).slice(0, 2), ['Accepted', 'Delivering']);
    const record = await f.store.read('unit-a');
    assert.deepEqual(record.deliveryResult, { level: 'none', head: 'head-1', mergeHead: null, effectRefs: [] });
    assert.equal(record.state, 'Delivered');
    assert.equal(result.sessionId, 'child');
  });
  test(`native ${runtime} rejects observed wrong worker cwd without relaunch`, async t => {
    const f = await fixture(t, { runtime, mode: 'native-wrong-child', separate: true });
    assert.equal(f.run('finish').code, 3);
    assert.equal(f.run('finish').code, 3);
    const launches = (await f.rows()).filter(row => row.binary === runtime && row.args.includes(runtime === 'cmux' ? 'new-workspace' : 'create'));
    assert.equal(launches.length, 1);
    assert.deepEqual((await f.ledger()).map(row => row.event), ['intent', 'verification']);
    assert.equal((await f.store.read('unit-a')).state, 'Delivered');
  });
}

test('native terminal launch accepts a plain acknowledgment and observes the worker inside a wrapper group', async t => {
  const f = await fixture(t, { runtime: 'cmux', mode: 'wrapped', separate: true });
  assert.equal(f.run('finish').code, 3);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
  const rows = await f.rows();
  assert.ok(rows.some(row => row.binary === 'lsof' && row.args.includes('203')));
  assert.ok(!rows.some(row => row.binary === 'lsof' && row.args.includes('202')));
});

test('native terminal reconciles an existing wrapped worker after a lost launch response without starting another', async t => {
  const f = await fixture(t, { runtime: 'cmux', mode: 'wrapped-lost-response', separate: true });
  assert.equal(f.run('finish').code, 3);
  const before = await f.ledger();
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
  assert.equal(f.run('finish').code, 3);
  const after = await f.ledger();
  assert.deepEqual(after[0], before[0]);
  assert.equal(after.filter(row => row.event === 'intent').length, 1);
  assert.equal((await f.rows()).filter(row => row.binary === 'cmux' && row.args.includes('new-workspace')).length, 1);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});

for (const mode of ['wrapped-mismatch', 'wrapped-background', 'wrapped-ambiguous', 'wrapped-late-ambiguous',
  'wrapped-changed', 'wrapped-exec-changed', 'wrapped-reused', 'wrapped-wrong-cwd', 'wrapped-cwd-changed',
  'wrapped-terminal-duplicate-initial', 'wrapped-terminal-duplicate-confirmed', 'wrapped-terminal-type-duplicate']) {
  test(`native terminal fails closed for ${mode}`, async t => {
    const f = await fixture(t, { runtime: 'cmux', mode, separate: true });
    assert.equal(f.run('finish').code, 3);
    assert.equal((await f.store.read('unit-a')).state, 'Delivered');
    assert.equal((await f.ledger()).filter(row => row.event === 'result').length, 0);
  });
}

test('public executable injects Git and gate descriptions and records isolated execution evidence', async t => {
  const f = await fixture(t, { state: 'SelfGated' });
  assert.equal(f.run('accept').code, 0);
  const record = await f.store.read('unit-a');
  assert.equal(record.state, 'Accepted');
  assert.equal(record.evidence.length, 5);
  for (const evidence of record.evidence) {
    assert.equal(evidence.execution.kind, 'isolated-snapshot-v1');
    assert.equal(evidence.execution.fingerprint, evidence.fingerprint);
    assert.match(await readFile(evidence.report, 'utf8'), /AC-1/);
  }
  assert.ok((await f.rows()).filter(row => row.event === 'describe').every(row => row.cwd === f.cwd));
  assert.equal(f.run('finish').code, 3);
});

test('none delivery resumes Delivering and rejects changed accepted content', async t => {
  const resume = await fixture(t, { state: 'Delivering' });
  assert.equal(resume.run('finish').code, 3);
  const changed = await fixture(t, { state: 'Accepted', mode: 'changed' });
  assert.equal(changed.run('finish').code, 1);
  assert.equal((await changed.store.read('unit-a')).state, 'SelfGated');
  assert.equal((await changed.rows()).some(row => row.event === 'execute'), false);
});

test('public executable returns structured configuration failures and protects core services', async t => {
  const f = await fixture(t);
  for (const source of ["export const unrelated = true;", "export function createRuntimeAdapters(){return {command(){}}}", "export function createRuntimeAdapters(){throw Error('provider unavailable')}", "export function createRuntimeAdapters(){return {gates:{describe(){}}}}" ]) {
    await writeFile(f.providers, source);
    assert.equal(f.run('finish').code, 4);
    assert.equal((await f.store.read('unit-a')).state, 'Delivered');
  }
});

test('public executable progress exposes exact same-record kind canon and acceptance without mutation', async t => {
  const f = await fixture(t);
  await f.store.update('unit-a', record => ({ ...record, kind: 'design',
    canon: [{ path: 'docs/criteria.md', snapshot: { approved: ['criterion-a', 'criterion-b'] } }],
    acceptance: [{ id: 'AC-1', text: 'Retain the approved criterion.', status: 'open' }, { id: 'AC-2', text: 'Preserve the excluded criterion.', status: 'dropped' }],
  }));
  const before = await f.store.read('unit-a');
  const result = f.run('progress');
  assert.equal(result.code, 0);
  assert.equal(result.unit, before.unit);
  assert.equal(result.kind, before.kind);
  assert.deepEqual(result.canon, before.canon);
  assert.deepEqual(result.acceptance, before.acceptance);
  assert.deepEqual(result.progress, { total: 2, active: 1, covered: 0, uncovered: 1, deferred: 0, dropped: 1, percent: 0 });
  assert.deepEqual(await f.store.read('unit-a'), before);
});

test('public executable close reports revalidation failure when the final target check changes', async t => {
  const f = await fixture(t, { mode: 'late-close-change' });
  const result = f.run('close');
  assert.equal(result.code, 1);
  assert.equal(result.status, 1);
  assert.equal(result.state, 'SelfGated');
  assert.equal(result.closePending, true);
  assert.match(result.summary, /requires revalidation/);
  assert.equal((await f.store.read('unit-a')).state, 'SelfGated');
});

test('conflicting parent identities and empty incarnations reject before effects', async t => {
  for (const update of [{ parentSessionId: 'other' }, { parentRuntime: { sessionId: 'parent', cwd: '/work/coordinator', incarnationId: '' } }]) {
    const f = await fixture(t, { separate: true });
    const request = JSON.parse(await readFile(f.request, 'utf8'));
    await writeFile(f.request, JSON.stringify({ ...request, ...update }));
    assert.equal(f.run('finish').code, 1);
    assert.equal((await f.ledger()).length, 0);
    assert.equal((await f.rows()).some(row => row.event === 'execute'), false);
  }
});

test('native target directory preflight fails before recording a start intent', async t => {
  const f = await fixture(t, { runtime: 'cmux', separate: true });
  const request = JSON.parse(await readFile(f.request, 'utf8'));
  request.successor.cwd = path.join(f.root, 'missing-product');
  await writeFile(f.request, JSON.stringify(request));
  assert.notEqual(f.run('finish').code, 0);
  assert.equal((await f.ledger()).length, 0);
  assert.equal((await f.rows()).some(row => row.args?.includes('new-workspace')), false);
});

test('Orca rejects absent native live process evidence before start', async t => {
  const f = await fixture(t, { runtime: 'orca', mode: 'native-no-process', separate: true });
  assert.equal(f.run('finish').code, 1);
  assert.equal((await f.ledger()).length, 0);
  assert.equal((await f.rows()).some(row => row.args?.includes('create')), false);
});

test('Orca rejects native process evidence older than its supported admission window', async t => {
  const f = await fixture(t, { runtime: 'orca', mode: 'native-stale', separate: true });
  assert.equal(f.run('finish').code, 1);
  assert.equal((await f.ledger()).length, 0);
});

test('Orca process incarnation change preserves uncertainty and never relaunches', async t => {
  const f = await fixture(t, { runtime: 'orca', mode: 'native-process-changed', separate: true });
  assert.equal(f.run('finish').code, 3);
  assert.equal(f.run('finish').code, 3);
  assert.equal((await f.rows()).filter(row => row.args?.includes('create')).length, 1);
  assert.deepEqual((await f.ledger()).map(row => row.event), ['intent', 'verification']);
  assert.equal((await f.store.read('unit-a')).state, 'Delivered');
});


test('public executable starts a detached finalizer that survives the finish caller exit', async t => {
  const f = await fixture(t, { mode: 'finalize', separate: true });
  const output = f.run('finish');
  assert.equal(output.code, 3);
  assert.equal(output.finalizePending, true);
  for (let attempt = 0; attempt < 100 && (await f.store.read('unit-a')).state !== 'Closed'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.store.read('unit-a')).state, 'Closed');
  const intents = (await f.ledger()).filter(row => row.event === 'intent');
  assert.deepEqual(intents.map(row => row.effect), ['session.start', 'session.deliver', 'session.close']);
  assert.equal(f.run('finalize').code, 0);
  assert.equal((await f.rows()).filter(row => row.event === 'execute' && row.effect === 'session.close').length, 1);
});

for (const runtime of ['cmux','orca']) for (const provider of ['codex','claude']) for (const mode of runtime === 'orca' ? ['success','native-title-changed','native-orphan'] : ['success']) {
  test(`managed ${runtime} ${provider} launch preserves pending goal and configured account (${mode})`, async t => {
    const f = await fixture(t,{runtime,mode,state:'Accepted',separate:true,managed:true,managedProvider:provider});
    const source = path.join(f.root,'goal.md'); await writeFile(source,'goal');
    const digest = `sha256:${createHash('sha256').update('goal').digest('hex')}`;
    const goals = createContinuityStore(f.stateRoot);
    await goals.create({goal:{id:'g1',objective:'finish',criteria:['tested'],remaining:['unit-a','unit-next'],status:'active'},policy:{runtime,provider,account:'/account',model:'model',effort:'high',argv:[provider]},source:{path:source,digest}});
    const incarnationId = runtime === 'cmux' ? 'ttys1:101:START' : 'parent-incarnation';
    await goals.transaction('g1',current=>({...current,revision:current.revision+1,bootstraps:[{unit:'unit-a',sessionId:'parent',incarnationId,cwd:f.parentCwd}]}));
    await f.store.update('unit-a',current=>({...current,continuityRequired:true,continuity:{goalId:'g1'}}));
    const outcome = f.run('finish');
    assert.equal(outcome.code,3,JSON.stringify(outcome));
    const started = (await f.rows()).find(row=>row.binary===runtime && row.args.includes(runtime==='cmux'?'new-workspace':'create'));
    assert.ok(started,JSON.stringify(await f.rows()));
    const command = started.args[started.args.indexOf('--command')+1];
    assert.ok(command.includes(provider === 'codex' ? "CODEX_HOME='/account'" : "CLAUDE_CONFIG_DIR='/account'")); assert.doesNotMatch(command,/goal snapshot/);
    const ledger = await f.ledger(); const intent = ledger.find(row=>row.effect==='session.start');
    assert.ok(intent.args.goalPath); assert.ok(intent.args.goalDigest);
    assert.equal(ledger.some(row=>row.event==='result' && row.seq===intent.seq),false,JSON.stringify(ledger));
  });
}
