import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAdapters } from './lib/adapters.mjs';
import { createSessionRunner } from './lib/session-runtime.mjs';
import { createContinuityStore } from './lib/continuity-store.mjs';
import { createUnitStateStore } from './lib/unit-state.mjs';
import { createLedgerStore, executeEffect } from './lib/ledger.mjs';
import { resolvePolicy } from './lib/policy.mjs';
import { taskDigest } from './lib/session-task.mjs';
import { runUnitCli } from './lib/unit-driver.mjs';

const parse = output => JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
const packet = ['목표: goal','수용 기준: done','작업관리: change','결정: review','변경: source','검증: checks','남은 일·위험: review','다음 단위 첫 행동: inspect'].join('\n');
async function fixture(t) {
  const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'native-recovery-')));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateRoot=path.join(cwd,'state'),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot);
  const source=path.join(cwd,'goal.md');await writeFile(source,'goal');
  await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining:['change'],status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/test-account',model:'model',effort:'high',argv:['codex']},source:{path:source,digest:taskDigest('goal')}});
  const owner={runtime:'cmux',sessionId:'owner',incarnationId:'tty1:11:START',cwd,worker:{executable:'codex',pid:11,incarnationId:'tty1:11:START',threadId:'owner-thread'}};
  await goals.transaction('g',g=>({...g,revision:g.revision+1,adoptions:[{unit:'change',ownership:'existing',...owner,owner}]}));
  await store.create({schema:'harness.unit/1',unit:'change',kind:'chore',state:'InReview',continuity:{goalId:'g'},head:'head',contentFingerprint:'content',policy:{goal:{class:'task'},review:{mode:'required',by:'session',triggers:[]}}});
  await store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'InReview',targetUnit:'change',continuity:{goalId:'g'},policy:{goal:{class:'task'}}});
  const nativeFile=path.join(cwd,'native.json'),stub=path.join(cwd,'native.mjs');
  await writeFile(nativeFile,JSON.stringify({exists:false,trust:false,native:'absent',absence:true,thread:'review-thread',draft:'',launches:0,returns:0,writes:[]}));
  const read=async()=>JSON.parse(await readFile(nativeFile));
  const edit=async fields=>writeFile(nativeFile,JSON.stringify({...await read(),...fields}));
  await writeFile(stub,`
import {readFileSync,writeFileSync} from 'node:fs';
const [binary,...args]=process.argv.slice(2),file=${JSON.stringify(nativeFile)},s=JSON.parse(readFileSync(file));const save=()=>writeFileSync(file,JSON.stringify(s));let out='';
if(binary==='pwd')out=process.cwd();
else if(binary==='ps')out=args.includes('pid=,pgid=,tpgid=,comm=')?(args.includes('tty1')?'11 11 11 codex':'22 22 22 codex'):(s.changed?'CHANGED':'START');
else if(binary==='lsof')out='n'+process.cwd()+'\\n';
else if(binary==='cmux'&&args.includes('identify'))out=JSON.stringify({caller:{surface_id:'owner'}});
else if(binary==='cmux'&&args.includes('new-workspace')){s.exists=true;s.launches++;s.title=args[args.indexOf('--name')+1];save();out='OK workspace:child'}
else if(binary==='cmux'&&args.includes('tree'))out=JSON.stringify({windows:[{id:'window',workspaces:[{id:'parent',title:'parent',panes:[{surfaces:[{id:'owner',type:'terminal',tty:'tty1'}]}]},...(s.exists?[{id:'child',title:s.title,panes:[{surfaces:[{id:'child',type:'terminal',tty:'tty2'}]}]}]:[])]}]});
else if(binary==='cmux'&&args.includes('read-screen'))out=s.trust?'› '+(s.draft||'Ask Codex to do anything')+'\\n model · Ready · context\\n ? for shortcuts':'Review plugin hooks and trust';
else if(binary==='cmux'&&(args.includes('rpc')||args.includes('send-key'))){
 const rows=readFileSync(${JSON.stringify(path.join(stateRoot,'units/review/ledger.ndjson'))},'utf8').trim().split('\\n').map(JSON.parse);
 if(!rows.some(row=>row.event==='submission'&&row.seq===1))throw Error('input preceded durable submission fence');
 if(s.mode==='crash-before-write'){s.mode='stopped';save();process.exit(9)}
 if(args.includes('rpc')){const text=JSON.parse(args.at(-1)).text;s.writes.push(text);s.draft+=text;save();out='OK'}
 else if(args.at(-1)==='Return'){s.returns++;s.native='started';s.draft='';save();if(s.mode==='lost-return')process.exit(9);out='OK'}
 else throw Error('unexpected key');
}else throw Error('unexpected native command '+binary+' '+args.join(' '));
process.stdout.write(out);
`);
  const core=createAdapters({repositoryRoot:cwd});
  const create=()=>{
    const command=(binary,args,options)=>core.command(process.execPath,[stub,binary,...args],options);
    const transport={identity:async observed=>({threadId:observed.pid===11?'owner-thread':(await read()).thread}),
      async observeGoal(request){const s=await read();if(s.native==='wrong')throw Error('different native goal');
        if(s.native==='absent')return {state:'absent',threadId:s.thread,fence:s.thread,notApplied:s.absence};
        return {state:s.native,threadId:s.thread,goal:{threadId:s.thread,status:'active',objective:request.prompt},
          enforcement:{status:'verified',cwd,key:'hook',hash:'hash'},turnId:'turn',activityId:'read-packets',packets:request.packets};}};
    const sessionRunner=createSessionRunner({runtime:'cmux',command,parent:{...owner,workerExecutable:'codex'},launch:()=>['codex'],taskTransport:transport,pollAttempts:1});
    return {...core,...createAdapters({sessionRunner}),git:{inspectUnit:async()=>({head:'head',contentFingerprint:'content'})}};
  };
  const handoff=path.join(cwd,'handoff.md');await writeFile(handoff,packet);
  const request=path.join(cwd,'start.json');await writeFile(request,JSON.stringify({cwd,handoffPath:handoff,handoffDigest:taskDigest(packet),parentRuntime:owner,waitSeconds:0}));
  const run=async()=>parse(await runUnitCli(['unit','session-start','review','--request',request],{cwd,stateRoot,adapters:create()}));
  const ledger=()=>createLedgerStore(stateRoot).withLock('review',l=>l.read());
  return {cwd,stateRoot,store,goals,source,read,edit,run,ledger,create,request};
}

test('public trust timeout recovers the same reviewer and seq1 on Ready, with one durable native submission across new runner instances',async t=>{
  const f=await fixture(t),before=await f.store.read('change');assert.equal((await f.run()).code,3);
  assert.equal((await f.read()).launches,1);assert.equal((await f.ledger()).filter(r=>r.event==='submission').length,0);
  await f.edit({trust:true});const result=await f.run();assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.seq,1);
  assert.equal((await f.run()).code,0);const native=await f.read(),rows=await f.ledger();
  assert.equal(native.launches,1);assert.equal(native.returns,1);assert.equal(rows.filter(r=>r.event==='intent').length,1);assert.equal(rows.filter(r=>r.event==='submission').length,1);
  assert.equal((await f.goals.read('g')).reviews.length,1);assert.deepEqual(await f.store.read('change'),before);
});

test('a crash immediately after the durable input boundary never retypes or presses Enter on repeated reconciliation',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).code,3);await f.edit({trust:true,mode:'crash-before-write'});
  assert.equal((await f.run()).code,3);for(let i=0;i<3;i++)assert.equal((await f.run()).code,3);
  const native=await f.read();assert.equal(native.launches,1);assert.equal(native.returns,0);assert.deepEqual(native.writes,[]);
  const rows=await f.ledger();assert.equal(rows.filter(r=>r.event==='submission').length,1);assert.equal(rows.filter(r=>r.event==='intent').length,1);
});

test('lost Return response and started goal are observed without another input; cleared goals cannot revive the submission',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).code,3);await f.edit({trust:true,mode:'lost-return'});
  assert.equal((await f.run()).code,3);assert.equal((await f.run()).code,0);const before=await f.read();
  await f.edit({native:'absent'});assert.equal((await f.run()).code,3);const after=await f.read();assert.equal(after.returns,before.returns);assert.deepEqual(after.writes,before.writes);
});

test('queued or missing absence evidence, foreign draft, native identity drift and changed packets do not permit recovery input',async t=>{
  for(const mode of ['absence','accepted','wrong-goal','draft','identity','packet'])await t.test(mode,async t=>{
    const f=await fixture(t);assert.equal((await f.run()).code,3);await f.edit({trust:true});
    if(mode==='absence')await f.edit({absence:false});if(mode==='accepted')await f.edit({native:'accepted'});if(mode==='wrong-goal')await f.edit({native:'wrong'});
    if(mode==='draft')await f.edit({draft:'unrelated user draft'});if(mode==='identity')await f.edit({changed:true});if(mode==='packet')await writeFile(path.join(f.cwd,'handoff.md'),'changed');
    assert.notEqual((await f.run()).code,0);const native=await f.read();assert.equal(native.launches,1);assert.equal(native.returns,0);assert.deepEqual(native.writes,[]);
  });
});

test('the original completed legacy effect without a fence remains observation-only',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).code,3);const rows=await f.ledger(),intent=rows.find(r=>r.event==='intent');
  await createLedgerStore(f.stateRoot).withLock('review',l=>l.append({event:'result',unit:'review',seq:intent.seq,key:intent.key,result:{sessionId:'child',incarnationId:'tty2:22:START',cwd:f.cwd}}));
  await f.edit({trust:true});assert.equal((await f.run()).code,3);assert.deepEqual((await f.read()).writes,[]);assert.equal((await f.ledger()).filter(r=>r.event==='submission').length,0);
});

test('submission persistence failure prevents all native input',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).code,3);await f.edit({trust:true});const ledger=createLedgerStore(f.stateRoot),intent=(await f.ledger()).find(r=>r.event==='intent'),adapters=f.create();
  const result=await executeEffect({unit:'review',effect:'session.start',args:intent.args,policy:resolvePolicy({project:{goal:{class:'task'}}},{nonInteractive:true}).policy,context:{explicitUserInstruction:true,productOwned:true},
    store:{withLock:(unit,action)=>ledger.withLock(unit,l=>action({...l,append:row=>{if(row.event==='submission')throw Error('disk sync failed');return l.append(row);}}))},
    adapter:{...adapters.session,now:adapters.now}});
  assert.notEqual(result.status,'completed');assert.deepEqual((await f.read()).writes,[]);
});

test('concurrent public reconciliation retains one original intent and one native submission',async t=>{
 const f=await fixture(t);assert.equal((await f.run()).code,3);await f.edit({trust:true});
 const results=await Promise.all([f.run(),f.run()]);assert.ok(results.some(r=>r.code===0),JSON.stringify(results));
 const native=await f.read(),rows=await f.ledger();assert.equal(native.launches,1);assert.equal(native.returns,1);assert.equal(rows.filter(r=>r.event==='submission').length,1);assert.equal(rows.filter(r=>r.event==='intent').length,1);
 assert.equal((await f.run()).code,0);
});
