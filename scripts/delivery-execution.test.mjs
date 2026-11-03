import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore } from './lib/ledger.mjs';
import { effectArgsDigest } from './lib/approvals.mjs';

const cli = fileURLToPath(new URL('./unit.mjs', import.meta.url));
const resultFields = { title: 'Completed work', objective: 'complete work', acceptance: 'AC-1 passes', tracking: 'none', decision: 'approved delivery', changed: 'src/main.mjs', verification: 'tests pass', remainingRisk: 'none', nextFirstAction: 'complete goal' };

async function fixture(t, { level = 'merge', mode = 'normal', committed = false, goalClass = 'product-prelaunch' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'delivery-execution-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product');
  await mkdir(cwd);
  const stateRoot = path.join(root, 'state');
  const native = path.join(root, 'repository.json');
  const trace = path.join(root, 'commands.ndjson');
  const target = { repo: 'example/product', branch: 'feature/work', base: 'main', head: 'head-1', tree: 'tree-1', indexTree: 'tree-1', headTree: committed ? 'tree-1' : 'tree-0', contentFingerprint: 'fp-1' };
  await writeFile(native, JSON.stringify({ mode, target, results: {}, prCount: 0 }));
  const store = createUnitStateStore(stateRoot);
  await store.create({ schema: 'harness.unit/1', unit: 'unit-a', revision: 0, kind: 'impl', state: 'Accepted',
    policy: { goal: { class: goalClass }, delivery: level, review: { mode: 'none', by: 'session', triggers: [] } },
    accepted: { ...target, basis: 'gates', validatedHead: 'head-1' }, head: target.head, contentFingerprint: target.contentFingerprint,
    reviewedHead: 'head-1', acceptance: [{ id: 'AC-1', status: 'open' }], evidence: [], stages: [], openDecisions: [], tracker: null });
  const stub = path.join(root, 'repository-stub.mjs');
  await writeFile(stub, `
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const [operation, encoded] = process.argv.slice(2); const input = JSON.parse(encoded);
const file = ${JSON.stringify(native)}; const s = JSON.parse(readFileSync(file));
const entry={operation,input,cwd:process.cwd()};
if(operation==='execute'){
 const rows=readFileSync(${JSON.stringify(path.join(stateRoot, 'units', 'unit-a', 'ledger.ndjson'))},'utf8').trim().split('\\n').map(JSON.parse);
 entry.intentObserved=rows.some(row=>row.event==='intent'&&row.seq===input.seq&&row.key===input.key&&row.effect===input.effect);
 if(!entry.intentObserved)throw Error('effect has no durable intent');
}
appendFileSync(${JSON.stringify(trace)},JSON.stringify(entry)+'\\n');
const save=()=>writeFileSync(file,JSON.stringify(s)); const out=x=>process.stdout.write(JSON.stringify(x));
const proof={adapter:'repository',operation:'effect.inspect',args:{effect:input.effect}};
if(operation==='inspect'){out(s.target)}
else if(operation==='context'){
 if(s.mode==='late-push-change'&&input.effect==='git.push'){s.target.head='external';save()}
 const c={resourceOwned:true,productOwned:true,inScope:true,operational:false,irreversible:s.mode.startsWith('irreversible')&&input.effect==='pr.merge',containsSecret:false,forbiddenCommand:false,explicitUserInstruction:true};
 if(s.mode==='missing-context')delete c.resourceOwned;
 if(s.mode==='foreign')c.resourceOwned=false;
 out(c)
}
else if(operation==='user-input'){
 out({verified:!s.mode.includes('unverified')&&input.userInputRef==='user-message-1',...input,...(s.mode==='wrong-input-tuple'?{head:'other'}:{})})
}
else if(operation==='verify'){
 const r=s.results[input.key];
 if(s.mode==='pr-unknown'&&input.effect==='pr.create'&&r){out({status:'unknown'});process.exit(0)}
 if(input.effect==='pr.create'){
  if(!r)out({status:'not-found',verify:proof});
  else out({status:s.mode==='closed-pr'?'closed':s.mode==='merged-pr'?'merged':'open',repo:r.repo,branch:r.branch,head:r.head,base:r.base,result:r,verify:proof});
 }else if(r?.status==='not-applied')out({status:'not-applied',verify:proof});
 else out(r?{status:'completed',result:r,verify:proof}:{status:'unknown',verify:proof})
}
else if(operation==='execute'){
 let r;
 if(input.effect==='git.commit'){
  if(s.mode==='hook-change'){s.target.tree='hook-tree';s.target.indexTree='hook-tree';s.target.contentFingerprint='hook-fp'}
  if(['hook-failure','auth-failure','harness-failure','environment-failure'].includes(s.mode))r={status:'not-applied',failure:{class:s.mode==='auth-failure'?'user-domain':s.mode==='harness-failure'?'harness':s.mode==='environment-failure'?'environment':'product',reason:s.mode},verify:proof};
  else {r={sha:'commit-1',parent:input.args.parent,tree:s.target.tree,contentFingerprint:s.target.contentFingerprint};s.target.head=r.sha;s.target.headTree=s.mode==='wrong-head-tree'?'unaccepted-tree':r.tree;s.target.headParent=s.mode==='wrong-parent'?'other-parent':input.args.parent}
 }else if(input.effect==='git.push'){
  r=['remote-ahead','remote-conflict'].includes(s.mode)?{status:'remote-ahead',remoteHead:'remote-2',verify:proof}:s.mode==='malformed-push'?{status:'success'}:{head:input.args.head};
 }else if(input.effect==='git.integrate'){
  s.target={...s.target,head:'integrated-2',tree:'tree-2',indexTree:'tree-2',headTree:'tree-2',contentFingerprint:'fp-2'};r=s.mode==='remote-conflict'?{status:'conflict',failure:{class:'product',reason:'integration conflict'},observed:{head:s.target.head,tree:s.target.tree,indexTree:s.target.indexTree,conflictPaths:['src/main.mjs']},verify:proof}:{head:s.target.head};s.mode='normal';
 }else if(input.effect==='pr.create')r={status:'open',pr:++s.prCount,...input.args};
 else if(input.effect==='pr.merge')r={acceptedHead:input.args.head,base:input.args.base,mergeHead:'target-merge-9'};
 s.results[input.key]=r;save();
 if((s.mode==='commit-lost'&&input.effect==='git.commit')||(['pr-lost','pr-unknown'].includes(s.mode)&&input.effect==='pr.create')||(s.mode==='merge-lost'&&input.effect==='pr.merge'))process.exit(9);
 out(r)
}
`);
  const providers = path.join(root, 'providers.mjs');
  await writeFile(providers, `
export function createRuntimeAdapters({cwd,adapters}) {
 const call=async(operation,input)=>{const r=await adapters.command(${JSON.stringify(process.execPath)},[${JSON.stringify(stub)},operation,JSON.stringify(input)],{cwd});if(r.exitCode!==0)throw Error('lost repository response');return JSON.parse(r.stdout)};
 const methods={deliveryContext:x=>call('context',x),execute:x=>call('execute',x),verify:x=>call('verify',x)};
 return {git:{inspectUnit:x=>call('inspect',x),...methods},repository:{...methods},provider:{verifyUserInput:x=>call('user-input',x)},
  gates:{async describe(id){return{id,command:['gate',id],files:[{path:'src/main.mjs',content:'source'}],format:'exec',reportPath:'report.json'}},async run(){return{exit:0,ok:true,covers:['AC-1'],report:'{}',reportPath:'report.json'}}}};
}
`);
  const request = path.join(root, 'finish.json');
  const finishRequest = { goalComplete: true, requestedDelivery: level, resultFields };
  await writeFile(request, JSON.stringify(finishRequest));
  const run = (command, extra = []) => {
    const positional = command === 'approval' ? ['approval', 'record', 'unit-a'] : command === 'policy' ? ['policy', 'change', 'unit-a'] : [command, 'unit-a'];
    const r = spawnSync(process.execPath, [cli, 'unit', ...positional, '--state-root', stateRoot, '--project-root', cwd, '--adapters', providers,
      ...(command === 'finish' ? ['--request', request] : []), ...extra], { cwd, encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').at(-1);
    assert.match(line ?? '', /^RESULT /, r.stderr);
    return { ...JSON.parse(line.slice(7)), exit: r.status };
  };
  const editNative = async edit => { const s = JSON.parse(await readFile(native, 'utf8')); edit(s); await writeFile(native, JSON.stringify(s)); };
  const commands = async () => JSON.parse(`[${(await readFile(trace,'utf8')).trim().split('\n').join(',')}]`);
  const ledger = () => createLedgerStore(stateRoot).withLock('unit-a', l => l.read());
  return { root, cwd, stateRoot, store, run, ledger, commands, editNative, native, request, finishRequest,
    async editRequest(edit) { edit(finishRequest); await writeFile(request, JSON.stringify(finishRequest)); },
    async approve(args, ref = 'user-message-1') {
      const file = path.join(root, 'approval.json');
      await writeFile(file, JSON.stringify({ effect: 'pr.merge', args, reason: 'approved irreversible delivery' }));
      return run('approval', ['--request', file, '--user-input', ref]);
    },
  };
}

const effects = rows => rows.filter(row => row.operation === 'execute').map(row => row.input.effect);

test('public delivery commits the exact accepted tree, preserves reviewed/validated SHA, and merges exact head/base', async t => {
  const f = await fixture(t);
  const result = f.run('finish');
  assert.equal(result.code, 0, JSON.stringify(result));
  const record = await f.store.read('unit-a');
  assert.equal(record.state, 'Closed');
  assert.equal(record.accepted.head, 'commit-1');
  assert.equal(record.accepted.validatedHead, 'head-1');
  assert.equal(record.reviewedHead, 'head-1');
  assert.equal(record.deliveryResult.head, 'commit-1');
  assert.equal(record.deliveryResult.mergeHead, 'target-merge-9');
  assert.deepEqual(effects(await f.commands()), ['git.commit','git.push','pr.create','pr.merge']);
  const ledger = await f.ledger();
  const binding = ledger.find(row => row.event === 'binding');
  assert.equal(binding.beforeHead, 'head-1');
  assert.equal(binding.afterHead, 'commit-1');
  assert.equal(binding.tree, 'tree-1');
  assert.equal(record.deliveryResult.effectRefs.length, 4);
  assert.equal((await f.commands()).every(row => row.cwd === f.cwd), true);
  assert.equal((await f.commands()).filter(row=>row.operation==='execute').every(row=>row.intentObserved===true),true);
});

test('public commit hook content changes return to SelfGated before outward effects', async t => {
  const f = await fixture(t, { mode: 'hook-change' });
  assert.equal(f.run('finish').code, 1);
  assert.equal((await f.store.read('unit-a')).state, 'SelfGated');
  assert.deepEqual(effects(await f.commands()), ['git.commit']);
  await f.editNative(s=>{s.mode='normal';});
  assert.equal(f.run('accept').code,0);
  assert.equal(f.run('finish').code,0);
  assert.deepEqual(effects(await f.commands()),['git.commit','git.push','pr.create','pr.merge']);
});

test('public commit response loss reconciles original intent and binds same-tree new SHA without duplicate commit', async t => {
  const f = await fixture(t, { level: 'commit', mode: 'commit-lost' });
  assert.equal(f.run('finish').code, 3);
  assert.equal(f.run('finish').code, 0);
  assert.deepEqual(effects(await f.commands()), ['git.commit']);
  assert.equal((await f.ledger()).filter(row => row.event === 'intent').length, 1);
});

test('public push revalidates immediately before external execution', async t => {
  const f = await fixture(t, { level: 'push', mode: 'late-push-change', committed: true });
  assert.equal(f.run('finish').code, 1);
  assert.equal((await f.store.read('unit-a')).state, 'SelfGated');
  assert.deepEqual(effects(await f.commands()), []);
});

test('public remote-ahead integrates once and requires fresh acceptance before normal push', async t => {
  const f = await fixture(t, { level: 'push', mode: 'remote-ahead', committed: true });
  assert.equal(f.run('finish').code, 1);
  assert.equal((await f.store.read('unit-a')).state, 'SelfGated');
  assert.equal(f.run('accept').code, 0);
  assert.equal(f.run('finish').code, 0);
  assert.deepEqual(effects(await f.commands()), ['git.push','git.integrate','git.push']);
  const pushes = (await f.commands()).filter(row => row.operation === 'execute' && row.input.effect === 'git.push');
  assert.equal(pushes[1].input.args.head, 'integrated-2');
  assert.notEqual(pushes[0].input.key, pushes[1].input.key);
});

test('public PR uncertainty is inspection-only until exact existing open PR resolves', async t => {
  const f = await fixture(t, { level: 'pr', mode: 'pr-unknown', committed: true });
  assert.equal(f.run('finish').code, 3);
  assert.equal(f.run('finish').code, 3);
  await f.editNative(s => { s.mode='normal'; });
  assert.equal(f.run('finish').code, 0);
  assert.equal(effects(await f.commands()).filter(effect => effect === 'pr.create').length, 1);
  assert.equal((await f.ledger()).filter(row => row.event === 'intent' && row.effect === 'pr.create').length, 1);
});

for (const mode of ['closed-pr','merged-pr']) test(`public new delivery never reuses ${mode}`, async t => {
  const f = await fixture(t, { level: 'pr', committed: true });
  assert.equal(f.run('finish').code, 0);
  await f.store.update('unit-a', r => ({ ...r, state:'Accepted', deliveryResult:null }));
  await f.editNative(s => { s.mode=mode; });
  assert.equal(f.run('finish').code, 0);
  assert.equal(effects(await f.commands()).filter(effect => effect === 'pr.create').length, 2);
});

for (const [mode,state] of [['hook-failure','Implementing'],['auth-failure','Stopped'],['harness-failure','Blocked'],['environment-failure','Blocked']]) test(`public ${mode} routes through canonical recovery to ${state}`, async t => {
  const f = await fixture(t, { level:'commit', mode });
  assert.equal(f.run('finish').code, 3);
  const record = await f.store.read('unit-a');
  assert.equal(record.state, state);
  assert.equal(record.failures.length, 1);
  assert.deepEqual(effects(await f.commands()), ['git.commit']);
});

test('public delivery policy and trusted resource context reject effects before external execution', async t => {
  const f = await fixture(t, { level:'commit' });
  await f.editRequest(r => { r.requestedDelivery='merge'; });
  assert.equal(f.run('finish').code, 3);
  await f.editRequest(r => { r.requestedDelivery='commit'; });
  await f.editNative(s => { s.mode='foreign'; });
  assert.equal(f.run('finish').code, 3);
  assert.deepEqual(effects(await f.commands()), []);
});

const mergeArgs = { repo:'example/product',pr:1,head:'head-1',base:'main' };

test('public approval record stores a trusted exact tuple and authorizes irreversible merge after ledger intent', async t => {
  const f = await fixture(t, { mode:'irreversible', committed:true });
  const approved = await f.approve(mergeArgs);
  const approval = approved.approval;
  assert.equal(approved.code, 0);
  assert.equal(approval.effect, 'pr.merge');
  assert.equal(approval.argsDigest, effectArgsDigest(mergeArgs));
  assert.equal(approval.head, 'head-1');
  assert.equal(approval.userInputRef, 'user-message-1');
  assert.ok(approval.id && approval.approvedAt && approval.reason);
  await f.editRequest(r => { r.delivery={approvalRef:approval.id}; });
  assert.equal(f.run('finish').code, 0);
  const rows = await f.ledger();
  const intent = rows.find(row => row.event==='intent' && row.effect==='pr.merge');
  assert.equal(intent.class, 'E4');
  assert.equal(intent.approvalRef, approval.id);
  assert.equal(rows.findIndex(row => row.event==='result' && row.seq===intent.seq)>rows.indexOf(intent),true);
});

for (const mode of ['unverified-input','wrong-input-tuple']) test(`public approval rejects ${mode}`, async t => {
  const f = await fixture(t, { mode, committed:true });
  assert.equal((await f.approve(mergeArgs)).code, 3);
  assert.equal((await f.store.read('unit-a')).approvals, undefined);
  assert.deepEqual(effects(await f.commands()), []);
});

test('public irreversible delivery rejects absent, fabricated, changed-args and stale-head approvals', async t => {
  for (const change of ['absent','fabricated','args','head']) {
    const f = await fixture(t, { mode:'irreversible', committed:true });
    let approval;
    if (['args','head'].includes(change)) approval=(await f.approve(change==='args'?{...mergeArgs,pr:99}:mergeArgs)).approval;
    if(change==='head') {
      await f.editNative(s=>{s.target.head='head-2';});
      await f.store.update('unit-a',r=>({...r,accepted:{...r.accepted,head:'head-2'},head:'head-2'}));
    }
    await f.editRequest(r=>{r.delivery={approvalRef:approval?.id??(change==='fabricated'?'self-asserted':undefined)};});
    assert.equal(f.run('finish').code,3,change);
    assert.equal(effects(await f.commands()).includes('pr.merge'),false,change);
    assert.equal((await f.ledger()).some(row=>row.event==='intent'&&row.effect==='pr.merge'),false,change);
  }
});

test('resolved nonapplied commit retries only after canonical recovery and fresh acceptance', async t => {
  const f = await fixture(t, { level:'commit', mode:'hook-failure' });
  assert.equal(f.run('finish').code,3);
  assert.equal((await f.store.read('unit-a')).state,'Implementing');
  await f.store.transition('unit-a','SelfGated');
  await f.editNative(s=>{s.mode='normal';});
  assert.equal(f.run('accept').code,0);
  assert.equal(f.run('finish').code,0);
  assert.deepEqual(effects(await f.commands()),['git.commit','git.commit']);
  assert.equal((await f.ledger()).filter(row=>row.event==='intent'&&row.effect==='git.commit').length,2);
});

test('a PR closed after an uncertain response is resolved and replaced without reusing it', async t => {
  const f = await fixture(t,{level:'pr',committed:true,mode:'pr-unknown'});
  assert.equal(f.run('finish').code,3);
  await f.editNative(s=>{s.mode='closed-pr';});
  assert.equal(f.run('finish').code,0);
  assert.equal(effects(await f.commands()).filter(effect=>effect==='pr.create').length,2);
  const rows=await f.ledger();
  assert.equal(rows.filter(row=>row.event==='intent'&&row.effect==='pr.create').length,2);
  assert.ok(rows.some(row=>row.event==='result'&&row.result?.status==='closed'));
});

test('a mismatched open PR cannot reconcile an uncertain request', async t => {
  const f = await fixture(t,{level:'pr',committed:true,mode:'pr-unknown'});
  assert.equal(f.run('finish').code,3);
  await f.editNative(s=>{s.mode='normal';Object.values(s.results).find(r=>r?.pr).base='different-base';});
  assert.equal(f.run('finish').code,3);
  assert.equal(effects(await f.commands()).filter(effect=>effect==='pr.create').length,1);
});

test('public integration conflicts retain observed mutation and route to implementation',async t=>{
  const f=await fixture(t,{level:'push',committed:true,mode:'remote-conflict'});
  assert.equal(f.run('finish').code,3);
  assert.equal((await f.store.read('unit-a')).state,'Implementing');
  const rows=await f.ledger();
  assert.equal(rows.find(row=>row.event==='result'&&row.result?.status==='conflict').result.observed.head,'integrated-2');
  assert.deepEqual(effects(await f.commands()),['git.push','git.integrate']);
});

test('malformed push outcomes remain uncertain and never trigger a duplicate push or PR',async t=>{
  const f=await fixture(t,{level:'pr',committed:true,mode:'malformed-push'});
  assert.equal(f.run('finish').code,3);
  assert.equal(f.run('finish').code,3);
  assert.deepEqual(effects(await f.commands()),['git.push']);
});

test('E4 class deny applies to an escalated merge even with verified approval',async t=>{
  const f=await fixture(t,{committed:true,mode:'irreversible'});
  const approval=(await f.approve(mergeArgs)).approval;
  await f.store.update('unit-a',r=>({...r,policy:{...r.policy,authority:{allow:['E3'],deny:['E4']}}}));
  await f.editRequest(r=>{r.delivery={approvalRef:approval.id};});
  assert.equal(f.run('finish').code,3);
  assert.equal(effects(await f.commands()).includes('pr.merge'),false);
});

test('stored approvals are reverified and rejected when the trusted input is revoked',async t=>{
  const f=await fixture(t,{committed:true,mode:'irreversible'});
  const approval=(await f.approve(mergeArgs)).approval;
  await f.editNative(s=>{s.mode='irreversible-unverified';});
  await f.editRequest(r=>{r.delivery={approvalRef:approval.id};});
  assert.equal(f.run('finish').code,3);
  assert.equal(effects(await f.commands()).includes('pr.merge'),false);
});

test('approval can bind a new delivery commit while paused before irreversible merge',async t=>{
  const f=await fixture(t,{mode:'irreversible'});
  assert.equal(f.run('finish').code,3);
  assert.equal((await f.store.read('unit-a')).accepted.head,'commit-1');
  const approved=await f.approve({...mergeArgs,head:'commit-1'});
  assert.equal(approved.code,0);
  await f.editRequest(r=>{r.delivery={approvalRef:approved.approval.id};});
  assert.equal(f.run('finish').code,0);
  assert.equal(effects(await f.commands()).filter(effect=>effect==='git.commit').length,1);
});

test('public delivery rejects incomplete trusted context before writing an intent',async t=>{
  const f=await fixture(t,{level:'commit',mode:'missing-context'});
  assert.equal(f.run('finish').code,4);
  assert.equal((await f.ledger()).length,0);
  assert.deepEqual(effects(await f.commands()),[]);
});

test('public merge uses the currently verified replacement PR identity, never the historical closed PR',async t=>{
  const f=await fixture(t,{committed:true,mode:'irreversible'});
  assert.equal(f.run('finish').code,3);
  await f.editNative(s=>{const pr=Object.values(s.results).find(r=>r?.pr);pr.pr=2;s.prCount=2;});
  const approved=await f.approve({...mergeArgs,pr:2});
  assert.equal(approved.code,0);
  await f.editRequest(r=>{r.delivery={approvalRef:approved.approval.id};});
  assert.equal(f.run('finish').code,0);
  const merge=(await f.commands()).find(row=>row.operation==='execute'&&row.input.effect==='pr.merge');
  assert.equal(merge.input.args.pr,2);
  const rows=await f.ledger();
  assert.equal(rows.findLast(row=>row.event==='result'&&row.result?.pr).result.pr,2);
});

for(const mode of ['wrong-parent','wrong-head-tree'])test(`public commit independently refuses ${mode} before push`,async t=>{
  const f=await fixture(t,{mode});
  assert.equal(f.run('finish').code,1);
  assert.equal((await f.store.read('unit-a')).state,'SelfGated');
  assert.deepEqual(effects(await f.commands()),['git.commit']);
});

test('changed accepted head creates a new PR key and merges only the newly accepted head',async t=>{
  const f=await fixture(t,{committed:true,mode:'irreversible'});
  assert.equal(f.run('finish').code,3);
  await f.editNative(s=>{s.target.head='head-2';s.mode='normal';});
  assert.equal(f.run('finish').code,1);
  assert.equal(f.run('accept').code,0);
  assert.equal(f.run('finish').code,0);
  const commands=await f.commands();
  const prs=commands.filter(row=>row.operation==='execute'&&row.input.effect==='pr.create');
  assert.equal(prs.length,2);
  assert.notEqual(prs[0].input.key,prs[1].input.key);
  assert.equal(commands.find(row=>row.operation==='execute'&&row.input.effect==='pr.merge').input.args.head,'head-2');
});

test('authorized policy change reaccepts and public finish delivers the selected level', async t => {
  const f=await fixture(t,{level:'none'}), before=await f.store.read('unit-a');
  const policyRequest=path.join(f.root,'policy-change.json');
  await writeFile(policyRequest,JSON.stringify({id:'merge-policy',expectedRevision:before.revision,delivery:'merge',reason:'user chose merge'}));
  const changed=f.run('policy',['--request',policyRequest,'--user-input','user-message-1']);
  assert.equal(changed.code,0,JSON.stringify(changed)); assert.equal((await f.store.read('unit-a')).state,'SelfGated');
  const accepted=f.run('accept'); assert.equal(accepted.code,0,JSON.stringify(accepted));
  await f.editRequest(r=>{r.requestedDelivery='none';});
  assert.equal(f.run('finish').error,'POLICY_CHANGE_MISMATCH');
  await f.editRequest(r=>{delete r.requestedDelivery;});
  const delivered=f.run('finish'); assert.equal(delivered.code,0,JSON.stringify(delivered));
  assert.equal((await f.store.read('unit-a')).deliveryResult.level,'merge');
  assert.deepEqual(effects(await f.commands()),['git.commit','git.push','pr.create','pr.merge']);
});

test('resumed merged delivery retains the original PR and merge effect identities', async t => {
  const f=await fixture(t,{committed:true}); assert.equal(f.run('finish').code,0);
  const before=await f.ledger();
  await f.store.update('unit-a',r=>({...r,state:'Delivering',deliveryResult:null}));
  await f.editNative(s=>{s.mode='merged-pr';});
  const result=f.run('finish'); assert.equal(result.code,0,JSON.stringify(result));
  assert.deepEqual(effects(await f.commands()),['git.push','pr.create','pr.merge']);
  const after=await f.ledger();
  assert.deepEqual(after.filter(row=>row.event==='intent').map(({seq,key,effect})=>({seq,key,effect})),before.filter(row=>row.event==='intent').map(({seq,key,effect})=>({seq,key,effect})));
  assert.equal((await f.store.read('unit-a')).deliveryResult.mergeHead,'target-merge-9');
});

test('resumed delivery refuses unverified merge or merged PR without a merge intent', async t => {
  for(const mode of ['unverified','missing-intent']) await t.test(mode,async t=>{
    const f=await fixture(t,{committed:true});assert.equal(f.run('finish').code,0);
    await f.store.update('unit-a',r=>({...r,state:'Delivering',deliveryResult:null}));
    if(mode==='unverified') await f.editNative(s=>{for(const [key,value] of Object.entries(s.results))if(value.acceptedHead)delete s.results[key];s.mode='merged-pr';});
    else {const file=path.join(f.stateRoot,'units','unit-a','ledger.ndjson'),rows=await f.ledger(),intent=rows.find(row=>row.event==='intent'&&row.effect==='pr.merge');
      await writeFile(file,rows.filter(row=>row.seq!==intent.seq).map(row=>JSON.stringify(row)).join('\n')+'\n');await f.editNative(s=>{s.mode='merged-pr';});}
    const result=f.run('finish');assert.equal(result.code,3,JSON.stringify(result));
    assert.deepEqual(effects(await f.commands()),['git.push','pr.create','pr.merge']);
  });
});

test('legacy in-progress merge without a delivery boundary is not replayed', async t => {
  const f=await fixture(t,{committed:true});assert.equal(f.run('finish').code,0);
  await f.store.update('unit-a',r=>{const {deliveryStartSeq,...rest}=r;return {...rest,state:'Delivering',deliveryResult:null};});
  await f.editNative(s=>{s.mode='merged-pr';});
  const result=f.run('finish');assert.equal(result.code,3,JSON.stringify(result));assert.match(result.summary,/Legacy delivery boundary/);
  assert.deepEqual(effects(await f.commands()),['git.push','pr.create','pr.merge']);
});

test('lost merge response reconciles the original intent without another PR or merge', async t => {
  const f=await fixture(t,{committed:true,mode:'merge-lost'});const first=f.run('finish');assert.equal(first.code,3,JSON.stringify(first));
  await f.editNative(s=>{s.mode='merged-pr';});
  const resumed=f.run('finish');assert.equal(resumed.code,0,JSON.stringify(resumed));
  assert.deepEqual(effects(await f.commands()),['git.push','pr.create','pr.merge']);
  const rows=await f.ledger();assert.equal(rows.filter(row=>row.event==='intent'&&row.effect==='pr.merge').length,1);
  assert.equal((await f.store.read('unit-a')).deliveryResult.mergeHead,'target-merge-9');
});

test('a new delivery boundary does not reuse a merged PR from a prior delivery', async t => {
  const f=await fixture(t,{committed:true});assert.equal(f.run('finish').code,0);
  const previous=await f.ledger(),start=Math.max(...previous.filter(row=>row.event==='intent').map(row=>row.seq));
  await f.store.update('unit-a',r=>({...r,state:'Delivering',deliveryStartSeq:start,deliveryResult:null}));
  await f.editNative(s=>{s.mode='merged-pr';});
  const result=f.run('finish');assert.equal(result.code,0,JSON.stringify(result));
  assert.equal(effects(await f.commands()).filter(effect=>effect==='pr.create').length,2);
  const intents=(await f.ledger()).filter(row=>row.event==='intent'&&row.effect==='pr.merge');assert.equal(intents.length,2);assert.ok(intents[1].seq>start);
});

test('legacy merge without a delivery boundary blocks before any new effect', async t => {
  const f=await fixture(t,{committed:true});
  await f.store.update('unit-a',r=>({...r,state:'Delivering'}));
  const result=f.run('finish');assert.equal(result.code,3,JSON.stringify(result));assert.match(result.summary,/Legacy delivery boundary/);
  assert.deepEqual(await f.ledger(),[]);
  await assert.rejects(readFile(path.join(f.root,'commands.ndjson'),'utf8'),{code:'ENOENT'});
});

test('interrupted merge reconciles an open PR receipt from the preceding delivery', async t => {
  const f=await fixture(t,{committed:true,level:'pr'});assert.equal(f.run('finish').code,0);
  await f.store.update('unit-a',r=>({...r,state:'Accepted',deliveryResult:null,policy:{...r.policy,delivery:'merge'}}));
  await f.editRequest(r=>{r.requestedDelivery='merge';});
  assert.equal(f.run('finish').code,0);
  const before=await f.ledger(),prIntent=before.find(row=>row.event==='intent'&&row.effect==='pr.create'),mergeIntent=before.find(row=>row.event==='intent'&&row.effect==='pr.merge');
  const boundary=(await f.store.read('unit-a')).deliveryStartSeq;assert.ok(prIntent.seq<=boundary && mergeIntent.seq>boundary);
  await f.store.update('unit-a',r=>({...r,state:'Delivering',deliveryResult:null}));await f.editNative(s=>{s.mode='merged-pr';});
  const resumed=f.run('finish');assert.equal(resumed.code,0,JSON.stringify(resumed));
  assert.equal(effects(await f.commands()).filter(effect=>effect==='pr.create').length,1);
  assert.equal(effects(await f.commands()).filter(effect=>effect==='pr.merge').length,1);
});

test('public merge delivery continues approved work in the same session', async t => {
  const f=await fixture(t);await f.editRequest(r=>{delete r.goalComplete;r.sameSession={approved:true,nextUnit:'next-work'};});
  const result=f.run('finish');assert.equal(result.code,0,JSON.stringify(result));
  const record=await f.store.read('unit-a');assert.equal(record.state,'Closed');assert.deepEqual(record.next,{unit:'next-work',sameSession:true});
  assert.doesNotMatch(record.result,/단위 종료 —/);assert.match(record.result,/다음 작업 단위: next-work$/);
  assert.deepEqual(effects(await f.commands()),['git.commit','git.push','pr.create','pr.merge']);
  assert.equal((await f.ledger()).some(row=>row.effect?.startsWith('session.')),false);
});
