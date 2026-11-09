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
});
