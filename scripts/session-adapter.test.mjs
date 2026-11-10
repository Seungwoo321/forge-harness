import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntimeAdapters} from './session-adapter.mjs';

test('packaged adapter reads the exact owner from the durable request or finalization record',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'session-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'units','u'),{recursive:true});
  const owner={runtime:'cmux',sessionId:'s',incarnationId:'i',cwd:root,worker:{executable:'codex'}};
  await writeFile(path.join(root,'units','u','unit.json'),JSON.stringify({sessionFinalization:{owner}}));
  const args={cwd:root,adapters:{command:async()=>{}},options:{'state-root':root},argv:['unit','finalize','u']};
  assert.equal(typeof (await createRuntimeAdapters(args)).sessionRunner.observe,'function');
  await writeFile(path.join(root,'request.json'),JSON.stringify({parentRuntime:{...owner,workerExecutable:'shell'}}));
  await assert.rejects(createRuntimeAdapters({...args,options:{...args.options,request:'request.json'}}),/worker executable/);
});

test('public CLI loads the packaged adoption observer, uses current goal account and never grants managed close authority',async t=>{
  const {realpath,readFile}=await import('node:fs/promises');
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const {createHash}=await import('node:crypto');
  const {createContinuityStore}=await import('./lib/continuity-store.mjs');
  const {createUnitStateStore}=await import('./lib/unit-state.mjs');
  const {effectArgsDigest}=await import('./lib/approvals.mjs');
  const {createAdapters}=await import('./lib/adapters.mjs');
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'packaged-custody-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot);
  const source=path.join(root,'goal.md');await writeFile(source,'goal');
  const policy={runtime:'cmux',provider:'codex',account:'/current-account',model:'model',effort:'high',argv:['codex']};
  await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy,source:{path:source,digest:hash('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u',kind:'chore',state:'InReview',continuity:{goalId:'g'},accepted:null,
    head:'head',contentFingerprint:'content',policy:{session:{...policy,account:'/historical-account'},review:{mode:'required',by:'session',triggers:[]}}});
  const owner={runtime:'cmux',sessionId:'surface',incarnationId:'tty1:42:START',cwd:root,
    worker:{executable:'codex',pid:42,incarnationId:'tty1:42:START',threadId:'11111111-1111-4111-8111-111111111111'}};
  const authority=path.join(root,'permission.txt');await writeFile(authority,'Authorized existing owner for unit u and goal g');
  const target={head:'head',contentFingerprint:'content'},unit=await store.read('u'),before=await readFile(path.join(stateRoot,'units/u/unit.json'));
  const request={id:'adopt',expectedRevision:unit.revision,expectedGoalRevision:1,unitDigest:effectArgsDigest(unit),goalDigest:effectArgsDigest(await goals.read('g')),
    targetDigest:effectArgsDigest(target),owner,provenance:{ref:authority,digest:hash(await readFile(authority))},reason:'Explicit source-backed permission'};
  const requestFile=path.join(root,'adopt.json');await writeFile(requestFile,JSON.stringify(request));
  const stub=path.join(root,'native.mjs');await writeFile(stub,`
const [binary,...args]=process.argv.slice(2);let value;
if(binary==='cmux'&&args.includes('identify'))value=JSON.stringify({caller:{surface_id:'surface'}});
else if(binary==='cmux'&&args.includes('tree'))value=JSON.stringify({windows:[{id:'w',workspaces:[{id:'ws',panes:[{surfaces:[{id:'surface',type:'terminal',tty:'tty1'}]}]}]}]});
else if(binary==='ps')value=args.includes('pid=,pgid=,tpgid=,comm=')?'42 42 42 codex\\n':'START';
else if(binary==='pwd')value=process.cwd();
else if(binary==='lsof')value=args.includes('cwd')?'n'+process.cwd()+'\\n':'n/current-account/thread-writer-locks/11111111-1111-4111-8111-111111111111.lock\\n';
else throw Error('unexpected mutation '+binary+' '+args.join(' '));
process.stdout.write(value);
`);
  const packaged=fileURLToPath(new URL('./session-adapter.mjs',import.meta.url)),providers=path.join(root,'providers.mjs');
  await writeFile(providers,`
import {createRuntimeAdapters as packaged} from ${JSON.stringify(packaged)};
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
export async function createRuntimeAdapters(input){
 const command=(binary,args,options)=>input.adapters.command(process.execPath,[${JSON.stringify(stub)},binary,...args],options);
 const result=await packaged({...input,adapters:{...input.adapters,command}});
 return {...result,git:{inspectUnit:async()=>({head:'head',contentFingerprint:'content'})},provider:{
 verifyUserInput:async binding=>({...binding,verified:binding.userInputRef==='actual-message'&&binding.effect==='unit.session.adopt'}),
 verifySessionAdoption:async ({request,record,goal,target,...binding})=>({...binding,verified:goal.policy.account==='/current-account'&&record.policy.session.account==='/historical-account'
 &&'sha256:'+createHash('sha256').update(await readFile(request.provenance.ref)).digest('hex')===request.provenance.digest})}};
}
`);
  const cli=fileURLToPath(new URL('./unit.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[cli,'unit','session-adopt','u','--request',requestFile,'--user-input','actual-message',
    '--state-root',stateRoot,'--project-root',root,'--adapters',providers],{cwd:root,encoding:'utf8'});
  assert.equal(child.status,0,child.stdout+child.stderr);
  const result=JSON.parse(child.stdout.slice(child.stdout.lastIndexOf('RESULT ')+7));assert.equal(result.receipt.ownership,'existing');
  assert.deepEqual(await readFile(path.join(stateRoot,'units/u/unit.json')),before);
  const core=createAdapters({repositoryRoot:root});const command=(binary,args,options)=>core.command(process.execPath,[stub,binary,...args],options);
  const args={cwd:root,adapters:{command},options:{'state-root':stateRoot,request:requestFile},argv:['unit','session-adopt','u']};
  assert.equal((await (await createRuntimeAdapters(args)).sessionRunner.observe({cwd:root,targetCwd:root})).closable,false);
  // Stage submission has a nested verb and obtains its managed reviewer from goal custody without a new request file.
  await store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'u',continuity:{goalId:'g'}});
  await goals.transaction('g',g=>({...g,revision:g.revision+1,reviews:[{unit:'review',sessionId:'surface',incarnationId:owner.incarnationId,cwd:root}]}));
  const stage=await createRuntimeAdapters({...args,options:{'state-root':stateRoot},argv:['unit','stage','submit','review','review']});
  assert.equal((await stage.sessionRunner.observe({cwd:root,targetCwd:root})).closable,true);
  // A policy refresh does not change an adopted live owner's original account.
  await goals.transaction('g',g=>({...g,revision:g.revision+1,policy:{...g.policy,account:'/new-account'},
    policyChanges:[{previous:g.policy}]}));
  assert.equal((await (await createRuntimeAdapters({...args,options:{'state-root':stateRoot},argv:['unit','finish','u']})).sessionRunner.observe({cwd:root,targetCwd:root})).worker.threadId,owner.worker.threadId);
  // Goal recovery observes its request's actual unit using the prior custody account, never the changed goal default.
  const recoveryFile=path.join(root,'policy-recovery.json');await writeFile(recoveryFile,JSON.stringify({unit:'u',owner}));
  const recovery=await createRuntimeAdapters({...args,options:{'state-root':stateRoot,request:recoveryFile},argv:['goal','policy-recover','g']});
  const observed=await recovery.sessionRunner.observe({cwd:root,targetCwd:root});
  assert.equal(observed.worker.threadId,owner.worker.threadId);assert.equal(observed.closable,false);
  await writeFile(recoveryFile,JSON.stringify({unit:'../g',owner}));
  await assert.rejects(createRuntimeAdapters({...args,options:{'state-root':stateRoot,request:recoveryFile},argv:['goal','policy-recover','g']}),/state root and unit/);
});

test('packaged startup observer uses the original account after a policy refresh',async t=>{
  const {createHash}=await import('node:crypto');
  const {createContinuityStore}=await import('./lib/continuity-store.mjs');
  const {createUnitStateStore}=await import('./lib/unit-state.mjs');
  const {createLedgerStore}=await import('./lib/ledger.mjs');
  const {snapshotGoal}=await import('./lib/continuity-snapshot.mjs');
  const {prepareEffect}=await import('./lib/policy.mjs');
  const root=await mkdtemp(path.join(tmpdir(),'observer-account-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const source=path.join(root,'goal.md'),handoffPath=path.join(root,'handoff.md');await writeFile(source,'goal');await writeFile(handoffPath,'handoff');
  const goals=createContinuityStore(root),store=createUnitStateStore(root);
  const policy={runtime:'cmux',provider:'codex',account:'/old-account',model:'model',effort:'high',argv:['codex']};
  const goal=await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy,source:{path:source,digest:digest('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Implementing',continuity:{goalId:'g'}});
  const snapshot=await snapshotGoal(root,goal),args={unit:'u',role:'implementation',attempt:1,cwd:root,handoffPath,handoffDigest:digest('handoff'),goalPath:snapshot.path,goalDigest:snapshot.digest};
  await createLedgerStore(root).withLock('u',l=>l.append({event:'intent',effect:'session.start',args,key:prepareEffect('session.start',args).key,seq:1}));
  await goals.transaction('g',g=>({...g,revision:g.revision+1,policy:{...policy,account:'/new-account'}}));
  const owner={runtime:'cmux',sessionId:'surface',incarnationId:'tty1:42:START',cwd:root,workerExecutable:'codex'};
  await writeFile(path.join(root,'request.json'),JSON.stringify({parentRuntime:owner}));
  const command=async (binary,args)=>{
    let stdout;
    if(binary==='cmux'&&args.includes('identify'))stdout=JSON.stringify({caller:{surface_id:'surface'}});
    else if(binary==='cmux'&&args.includes('tree'))stdout=JSON.stringify({windows:[{id:'w',workspaces:[{id:'ws',panes:[{surfaces:[{id:'surface',type:'terminal',tty:'tty1'}]}]}]}]});
    else if(binary==='ps')stdout=args.includes('pid=,pgid=,tpgid=,comm=')?'42 42 42 codex\n':'START';
    else if(binary==='pwd')stdout=root;
    else if(binary==='lsof')stdout=args.includes('cwd')?'n'+root+'\n':'n/old-account/thread-writer-locks/11111111-1111-4111-8111-111111111111.lock\n';
    else throw Error('unexpected native mutation '+binary);
    return {exitCode:0,stdout};
  };
  const {sessionRunner}=await createRuntimeAdapters({cwd:root,adapters:{command},options:{'state-root':root,request:'request.json'},argv:['unit','session-start','u']});
  assert.equal((await sessionRunner.observe({cwd:root,targetCwd:root})).worker.threadId,'11111111-1111-4111-8111-111111111111');
  // A reconciled successful old worker keeps its account/runtime for stage submission and finish too.
  await goals.transaction('g',g=>({...g,revision:g.revision+1,bootstraps:[{unit:'u',attempt:1,...owner,goalPath:snapshot.path,goalDigest:snapshot.digest}],
    policy:{...g.policy,runtime:'orca',provider:'claude',argv:['claude']}}));
  for (const argv of [['unit','finish','u'],['unit','stage','submit','u','implement']]) {
    const {sessionRunner}=await createRuntimeAdapters({cwd:root,adapters:{command},options:{'state-root':root},argv});
    assert.equal((await sessionRunner.observe({cwd:root,targetCwd:root})).worker.threadId,'11111111-1111-4111-8111-111111111111');
  }
  // Same-session successors retain the old execution binding after refresh.
  const {commitGoalContinuation}=await import('./lib/continuity-finish.mjs');
  await goals.transaction('g',g=>({...g,revision:g.revision+1,goal:{...g.goal,remaining:['u','next']}}));
  const current=await goals.read('g');
  await store.update('u',r=>({...r,state:'Closed',goalContinuation:{goalId:'g',revision:current.revision,nextUnit:'next',owner}}));
  await commitGoalContinuation({continuityStore:goals,unitStore:store,goalId:'g',unit:'u'});
  await store.create({schema:'harness.unit/1',unit:'next',kind:'impl',state:'Implementing',continuity:{goalId:'g'}});
  const {sessionRunner:continued}=await createRuntimeAdapters({cwd:root,adapters:{command},options:{'state-root':root},argv:['unit','finish','next']});
  assert.equal((await continued.observe({cwd:root,targetCwd:root})).worker.threadId,'11111111-1111-4111-8111-111111111111');
});

test('public rebind uses the packaged observer and custom permission route, proving prior PID absence and preserving custody',async t=>{
  const {realpath,readFile}=await import('node:fs/promises');
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const {createHash}=await import('node:crypto');
  const {createContinuityStore}=await import('./lib/continuity-store.mjs');
  const {createUnitStateStore}=await import('./lib/unit-state.mjs');
  const {effectArgsDigest}=await import('./lib/approvals.mjs');
  const {goalOwner}=await import('./lib/continuity-custody.mjs');
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'packaged-rebind-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const stateRoot=path.join(root,'state'),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot);
  const source=path.join(root,'goal.md');await writeFile(source,'goal');
  const policy={runtime:'cmux',provider:'codex',account:'/current-account',model:'model',effort:'high',argv:['codex']};
  await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['u'],status:'active'},policy,source:{path:source,digest:hash('goal')}});
  await store.create({schema:'harness.unit/1',unit:'u',kind:'chore',state:'Accepted',continuity:{goalId:'g'},head:'head',contentFingerprint:'content',
    failures:[{signature:'preserved failure'}],accepted:{head:'head'},externalDeliveryEvidence:[{verified:true}]});
  const thread='11111111-1111-4111-8111-111111111111';
  const native=(pid,start)=>({runtime:'cmux',sessionId:'surface',incarnationId:`tty1:${pid}:${start}`,cwd:root,worker:{executable:'codex',pid,incarnationId:`tty1:${pid}:${start}`,threadId:thread}});
  const old=native(42,'OLD'),owner=native(84,'NEW'),previous={id:'original',unit:'u',ownership:'existing',...old,owner:old,policyDigest:effectArgsDigest(policy)};
  await goals.transaction('g',g=>({...g,revision:g.revision+1,adoptions:[previous]}));
  const authority=path.join(root,'permission.txt');await writeFile(authority,'Authorized same-thread owner recovery for unit u and goal g');
  const target={head:'head',contentFingerprint:'content'},unit=await store.read('u'),goal=await goals.read('g');
  const request={id:'rebind',expectedRevision:unit.revision,expectedGoalRevision:goal.revision,unitDigest:effectArgsDigest(unit),goalDigest:effectArgsDigest(goal),
    targetDigest:effectArgsDigest(target),owner,previousCustodyDigest:effectArgsDigest(previous),provenance:{ref:authority,digest:hash(await readFile(authority))},reason:'Source-authorized same-owner recovery'};
  const requestFile=path.join(root,'rebind.json'),modeFile=path.join(root,'mode.json');await writeFile(requestFile,JSON.stringify(request));
  const stub=path.join(root,'native.mjs');await writeFile(stub,`
import {readFileSync} from 'node:fs';
const mode=JSON.parse(readFileSync(${JSON.stringify(modeFile)}));const [binary,...args]=process.argv.slice(2);let value;
if(binary==='cmux'&&args.includes('identify'))value=JSON.stringify({caller:{surface_id:mode==='caller'?'other':'surface'}});
else if(binary==='cmux'&&args.includes('tree'))value=JSON.stringify({windows:[{id:'w',workspaces:[{id:'ws',panes:[{surfaces:[{id:'surface',type:'terminal',tty:'tty1'}]}]}]}]});
else if(binary==='ps'&&args.includes('-axo')){if(mode==='unavailable')process.exit(1);value=mode==='malformed'?'ambiguous':mode==='live'?'42\\n84\\n':'84\\n';}
else if(binary==='ps')value=args.includes('pid=,pgid=,tpgid=,comm=')?'84 84 84 codex\\n':'NEW';
else if(binary==='pwd')value=process.cwd();
else if(binary==='lsof')value=args.includes('cwd')?'n'+process.cwd()+'\\n':'n/current-account/thread-writer-locks/'+(mode==='thread'?'22222222-2222-4222-8222-222222222222':${JSON.stringify(thread)})+'.lock\\n';
else throw Error('unexpected native mutation '+binary+' '+args.join(' '));
process.stdout.write(value);
`);
  const packaged=fileURLToPath(new URL('./session-adapter.mjs',import.meta.url)),approvals=fileURLToPath(new URL('./lib/approvals.mjs',import.meta.url)),providers=path.join(root,'providers.mjs');
  await writeFile(providers,`
import {createRuntimeAdapters as packaged} from ${JSON.stringify(packaged)};
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {effectArgsDigest} from ${JSON.stringify(approvals)};
export async function createRuntimeAdapters(input){
 const command=(binary,args,options)=>input.adapters.command(process.execPath,[${JSON.stringify(stub)},binary,...args],options);
 const session=await packaged({...input,adapters:{...input.adapters,command}});
 const proof=async binding=>binding.userInputRef==='actual-rebind-message'&&binding.previousCustodyDigest===${JSON.stringify(request.previousCustodyDigest)}
 &&binding.ownerDigest===${JSON.stringify(effectArgsDigest(owner))}&&await readFile(${JSON.stringify(authority)},'utf8')==='Authorized same-thread owner recovery for unit u and goal g';
 return {...session,git:{inspectUnit:async()=>({head:'head',contentFingerprint:'content'})},provider:{
 verifyUserInput:async binding=>({...binding,verified:binding.effect==='unit.session.rebind'&&await proof(binding)}),
 verifySessionRebind:async ({request,record,goal,target,previousCustody,...binding})=>({...binding,verified:await proof(binding)
 &&effectArgsDigest(previousCustody)===binding.previousCustodyDigest&&effectArgsDigest(record)===binding.unitDigest&&effectArgsDigest(target)===binding.targetDigest
 &&goal.policy.account==='/current-account'&&'sha256:'+createHash('sha256').update(await readFile(request.provenance.ref)).digest('hex')===request.provenance.digest})}};
}
`);
  const cli=fileURLToPath(new URL('./unit.mjs',import.meta.url)),unitFile=path.join(stateRoot,'units/u/unit.json'),before=await readFile(unitFile);
  const run=()=>{const child=spawnSync(process.execPath,[cli,'unit','session-rebind','u','--request',requestFile,'--user-input','actual-rebind-message',
    '--state-root',stateRoot,'--project-root',root,'--adapters',providers],{cwd:root,encoding:'utf8'});return JSON.parse(child.stdout.slice(child.stdout.lastIndexOf('RESULT ')+7));};
  for(const mode of ['live','unavailable','malformed','caller','thread']){
    await writeFile(modeFile,JSON.stringify(mode));assert.notEqual(run().code,0,mode);assert.deepEqual(await readFile(unitFile),before);assert.deepEqual(await goals.read('g'),goal);
  }
  await writeFile(modeFile,JSON.stringify('absent'));const result=run();assert.equal(result.code,0,JSON.stringify(result));
  assert.equal(run().receipt.duplicate,true);const current=await goals.read('g');assert.equal(current.rebindings.length,1);assert.deepEqual(current.adoptions,[previous]);
  assert.deepEqual(goalOwner(current,'u').owner,owner);assert.deepEqual(await readFile(unitFile),before);
});
