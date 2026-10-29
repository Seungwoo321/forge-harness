import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const runtimeModule = new URL('./lib/session-runtime.mjs', import.meta.url).href;
const fields = { title: 'Completed work', objective: 'complete work', acceptance: 'AC-1 passes', tracking: 'none', decision: 'approved successor', changed: 'src/main.mjs', verification: 'tests pass', remainingRisk: 'none', nextFirstAction: 'read packet' };
const packet = ['목표: finish', '수용 기준: AC-1', '작업관리: none', '결정: approved', '변경: src/main.mjs', '검증: tests', '남은 일·위험: none', '다음 단위 첫 행동: read packet'].join('\n');

async function fixture(t, { state = 'Delivered', runtime = null, mode = 'success', separate = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'unit-executable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product checkout');
  const parentCwd = separate ? path.join(root, 'coordinator') : cwd;
  const bin = path.join(root, 'bin');
  await mkdir(cwd);
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
import { appendFile, readFile } from 'node:fs/promises';
import { createSessionRunner } from ${JSON.stringify(runtimeModule)};
export async function createRuntimeAdapters({cwd,adapters}) {
  const trace = x => appendFile(process.env.TEST_TRACE, JSON.stringify(x)+'\\n');
  const parentCwd = process.env.TEST_PARENT;
  const mode = process.env.TEST_MODE;
  const sessionRunner = process.env.TEST_RUNTIME ? createSessionRunner({runtime:process.env.TEST_RUNTIME,command:adapters.command,
    parent:{sessionId:'parent',incarnationId:${JSON.stringify(incarnationId)},cwd:parentCwd},launch:args=>['worker','--unit',args.unit],
    async runtimeRpc(method,params){const result=await adapters.command('orca-rpc',[method,JSON.stringify(params)],{cwd});if(result.exitCode!==0)throw Error('RPC failed');return JSON.parse(result.stdout)}}) : {
    contractVersion:'harness.session-adapter/1',capabilities:['fix-forward','failure-classification-five-way','retry-limit','ops-e0-only','policy-review'],
    async observe(input){await trace({event:'observe',...input});const observations=(await readFile(process.env.TEST_TRACE,'utf8')).trim().split('\\n').map(JSON.parse).filter(row=>row.event==='observe').length;return {sessionId:mode==='wrong-parent'||(mode==='late-parent'&&observations>1)?'wrong':'parent',cwd:mode==='wrong-parent-cwd'?cwd:parentCwd,incarnationId:${JSON.stringify(incarnationId)},targetCwd:mode==='wrong-target'?'wrong':input.targetCwd}},
    async execute(input){await trace({event:'execute',...input});if(mode==='uncertain')throw Error('lost response');return {sessionId:'child',cwd:mode==='wrong-child'?'wrong':input.args.cwd}},
    async verify(input){await trace({event:'verify',...input});return {status:'unknown'}}
  };
  return {sessionRunner,git:{async inspectUnit({record}) {await trace({event:'inspect',state:record.state,cwd});const inspections=(await readFile(process.env.TEST_TRACE,'utf8')).trim().split('\\n').map(JSON.parse).filter(row=>row.event==='inspect').length;return {head:'head-1',contentFingerprint:mode==='changed'||(mode==='late-close-change'&&inspections>=3)?'changed':'fp-1'}}},
    gates:{async describe(id){await trace({event:'describe',id,cwd});return {id,command:['gate',id],files:[{path:'src/main.mjs',content:'source'}],format:'exec',reportPath:'reports/'+id+'.json'}},
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
if(binary==='ps'){const child=args.includes('202')||args.includes('ttys2');process.stdout.write(args.includes('lstart=')?'START\\n':args.includes('tty=,pgid=,comm=')?(child?'ttys2 202 worker\\n':'ttys1 101 worker\\n'):args.includes('comm=')?'worker\\n':child?'202 202 202\\n':'101 101 101\\n')}
else if(binary==='lsof'){process.stdout.write('p1\\nn'+(process.env.TEST_MODE==='native-wrong-child'&&args.includes('202')?'/wrong':process.cwd())+'\\n')}
else if(binary==='orca-rpc'){
 const params=JSON.parse(args[1]);const child=params.terminal==='child';
 s.epoch=(s.epoch??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));
 const evidence={authorityGeneration:'generation-1',observationEpoch:s.epoch,capturedAgeMs:0,ptyId:params.terminal,ptyIncarnationId:params.expectedIncarnationId,verdict:'live',processName:'worker',fence:{platform:'posix',shellPid:1,shellStartTime:'START',tty:child?'ttys2':'ttys1',foregroundPgid:child?202:101,process:{pid:child?202:101,startTime:'START'}}};
 if(process.env.TEST_MODE==='native-no-process')evidence.verdict='unknown';
 if(process.env.TEST_MODE==='native-stale')evidence.capturedAgeMs=2001;
 if(child&&process.env.TEST_MODE==='native-process-changed'){s.inspections=(s.inspections??0)+1;writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));if(s.inspections>1)evidence.fence.process.startTime='CHANGED'}
 output({ok:true,result:{process:{foregroundProcessEvidence:evidence}}});
}
else if(binary==='cmux'){
 if(args.includes('identify'))output({caller:{surface_id:'parent'}});
 else if(args.includes('new-workspace')){s.child=true;s.title=args[args.indexOf('--name')+1];writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));output({workspace_id:'new'})}
 else {output({windows:[{id:'window',workspaces:[{id:'parent-workspace',title:'parent',panes:[{surfaces:[{id:'parent',type:'terminal',tty:'ttys1'}]}]},...(child?[{id:'child-workspace',title:s.title,panes:[{surfaces:[{id:'child',type:'terminal',tty:'ttys2'}]}]}]:[])]}]})}
} else {
 const terminal=id=>({handle:id,incarnationId:id+'-incarnation',worktreePath:id==='parent'?'/registered/coordinator-root':process.env.TEST_PRODUCT,connected:true,writable:true,title:s.title,worktreeId:'worktree',executionHostId:'local'});
 if(args.includes('create')){s.child=true;s.title=args[args.indexOf('--title')+1];writeFileSync(process.env.TEST_NATIVE,JSON.stringify(s));output({ok:true,result:{terminal:terminal('child')}})}
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
      cwd, encoding: 'utf8', env: { ...globalThis.process.env, PATH: `${bin}${path.delimiter}${globalThis.process.env.PATH}`, ORCA_TERMINAL_HANDLE: 'parent', TEST_TRACE: trace, TEST_NATIVE: nativeState, TEST_RUNTIME: runtime ?? '', TEST_MODE: mode, TEST_PARENT: parentCwd, TEST_PRODUCT: cwd },
    });
    const line = process.stdout.trim().split('\n').at(-1);
    assert.match(line ?? '', /^RESULT /, process.stderr);
    return { ...JSON.parse(line.slice(7)), status: process.status };
  };
  const rows = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const ledger = () => createLedgerStore(stateRoot).withLock('unit-a', entries => entries.read());
  return { root, cwd, parentCwd, store, request, providers, run, rows, ledger };
}

test('public executable loads configured generic runner and closes only after exact cwd start', async t => {
  const f = await fixture(t);
  assert.equal(f.run('finish').code, 0);
  const rows = await f.rows();
  assert.equal(rows[0].cwd, f.cwd);
  assert.equal(rows.find(row => row.event === 'execute').args.cwd, f.cwd);
  assert.equal((await f.store.read('unit-a')).state, 'Closed');
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
    assert.equal(result.code, 0, JSON.stringify(result));
    const rows = await f.rows();
    const started = rows.find(row => row.binary === runtime && row.args.includes(runtime === 'cmux' ? 'new-workspace' : 'create'));
    assert.equal(started.cwd, f.cwd);
    assert.ok(started.args.some(arg => arg.includes(f.cwd)));
    assert.ok(rows.some(row => row.binary === runtime && row.cwd === f.parentCwd));
    assert.deepEqual(rows.filter(row => row.event === 'inspect').map(row => row.state).slice(0, 2), ['Accepted', 'Delivering']);
    const record = await f.store.read('unit-a');
    assert.deepEqual(record.deliveryResult, { level: 'none', head: 'head-1', mergeHead: null, effectRefs: [] });
    assert.equal(record.state, 'Closed');
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

test('public executable injects Git and gate providers and preserves original evidence identity', async t => {
  const f = await fixture(t, { state: 'SelfGated' });
  assert.equal(f.run('accept').code, 0);
  const record = await f.store.read('unit-a');
  assert.equal(record.state, 'Accepted');
  assert.equal(record.evidence.length, 5);
  for (const evidence of record.evidence) {
    assert.equal(evidence.verdict, 'green');
    assert.equal(evidence.path, `reports/${evidence.gate}.json`);
    assert.equal(evidence.report, evidence.path);
    assert.equal(evidence.key, `original:${evidence.gate}`);
  }
  assert.ok((await f.rows()).filter(row => row.event === 'gate').every(row => row.cwd === f.cwd));
  assert.equal(f.run('finish').code, 0);
});

test('none delivery resumes Delivering and rejects changed accepted content', async t => {
  const resume = await fixture(t, { state: 'Delivering' });
  assert.equal(resume.run('finish').code, 0);
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
