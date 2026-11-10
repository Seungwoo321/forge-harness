import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAdapters} from './lib/adapters.mjs';
import {createRuntimeAdapters} from './session-adapter.mjs';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {runUnitCli} from './lib/unit-driver.mjs';
import {taskDigest} from './lib/session-task.mjs';
import {prepareEffect} from './lib/policy.mjs';

async function fixture(t,{pending=false,seed=true,expandedFooter=false}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'delivery-input-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const ownerThread='00000000-0000-0000-0000-000000000001',receiverThread='00000000-0000-0000-0000-000000000002';
  const native=(sessionId,pid,tty,threadId)=>({runtime:'cmux',sessionId,incarnationId:`${tty}:${pid}:START`,cwd:root,executable:'codex',pid,tty,workspaceId:sessionId+'-workspace',threadId});
  const own=native('owner',22,'tty1',ownerThread),recv=native('receiver',33,'tty2',receiverThread);
  const owner={...own,workerExecutable:'codex',worker:{...own}},recipient={...recv,worker:{...recv}};
  const content='immutable result\n',resultPath=path.join(root,'result.md'),resultDigest=taskDigest(content),handoffPath=path.join(root,'handoff.md'),handoffDigest=taskDigest('handoff\n');
  await writeFile(resultPath,content);await writeFile(handoffPath,'handoff\n');
  const plan={mode:'review',owner,recipient,resultPath,resultDigest,handoffPath,handoffDigest};
  const args={...plan,cwd:root,session:recipient.sessionId,incarnation:recipient.incarnationId},key=prepareEffect('session.deliver',args).key;
  const store=createUnitStateStore(root);await store.create({schema:'harness.unit/1',unit:'review',kind:'review',state:'Closed',policy:{goal:{class:'task'},delivery:'none'},sessionFinalization:plan,acceptance:[],openDecisions:[],tracker:null});
  const ledgerPath=path.join(root,'units/review/ledger.ndjson'),intent={event:'intent',unit:'review',seq:2,class:'E3',effect:'session.deliver',key,args,intent_at:'time'};
  const observations=Array.from({length:45},()=>({event:'verification',unit:'review',seq:2,key,status:'unknown',verify:{code:'SESSION_TASK_UNVERIFIED',message:'supported Codex composer is unavailable'}}));
  await writeFile(ledgerPath,seed?[intent,...observations].map(JSON.stringify).join('\n')+'\n':'');
  const prompt=`Read ${resultPath} (${resultDigest}); follow its referenced handoffs.`;
  const state={draft:pending?prompt:'Ask Codex to do anything',mode:'normal',native:'ready',thread:receiverThread,pastes:0,returns:0,closes:0,closed:false,packetRead:true,footerStatus:'Ready'};
  const rows=async()=>(await readFile(ledgerPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const command=async(binary,argv,options)=>{
    const records=await rows(),marked=records.some(r=>r.event==='submission'),confirmed=records.some(r=>r.event==='confirmation');
    const change=/^boundary-(submission|confirmation)-(draft|packet|native)$/.exec(state.mode);
    if(change&&!state.boundaryChanged&&(change[1]==='submission'?marked:confirmed)){
      state.boundaryChanged=true;
      if(change[2]==='draft')state.draft='human draft';
      if(change[2]==='packet')await writeFile(resultPath,'changed during checkpoint');
      if(change[2]==='native')state.native='queued';
    }
    if(state.mode==='crash-submission'&&marked||state.mode==='crash-confirmation'&&confirmed)throw Error('simulated process loss after synced boundary');
    let stdout;
    if(binary==='cmux'&&argv.includes('tree'))stdout=JSON.stringify({windows:[{workspaces:[...(!state.closed?[{id:'owner-workspace',panes:[{surfaces:[{id:'owner',type:'terminal',tty:'tty1'},{id:'user-shell',type:'terminal',tty:'tty9'}]}]}]:[]),{id:'receiver-workspace',panes:[{surfaces:[{id:'receiver',type:'terminal',tty:'tty2'}]}]}]}]});
    else if(binary==='ps')stdout=argv.includes('tty=')?'supervisor':argv.includes('pid=,pgid=,tpgid=,comm=')?(argv.includes('tty1')?'22 22 22 codex':'33 33 33 codex'):'START';
    else if(binary==='lsof')stdout=argv.includes('-d')?'n'+root+'\n':`n${process.env.CODEX_HOME??process.env.HOME+'/.codex'}/thread-writer-locks/${argv.includes('22')?ownerThread:state.thread}.lock\n`;
    else if(binary==='cmux'&&argv.includes('terminal.viewport'))stdout=JSON.stringify({surface_id:'receiver',columns:44});
    else if(binary==='cmux'&&argv.includes('read-screen')){const text=state.draft.match(/.{1,42}/gu)??[''];stdout=`› ${text.join('\n  ')}\n\n`+(expandedFooter ? `  GPT-6.1-Sol high · ~/work/product · fix/change · ${state.footerStatus} ·…  ⚠ 1 warning · f2 to view\n` : '  Model high · ~/work…\n  ? for shortcuts\n');}
    else if(binary==='cmux'&&argv.includes('surface.send_text')){assert.equal(marked,true);assert.equal(confirmed,false);state.draft=JSON.parse(argv.at(-1)).text;state.pastes++;if(state.mode==='crash-paste')throw Error('paste acknowledgement lost');stdout='{}';}
    else if(binary==='cmux'&&argv.includes('send-key')){assert.equal(argv.at(-1),'Return');assert.ok(marked&&confirmed);state.returns++;state.native=state.mode==='queued'?'queued':state.mode==='accepted'?'accepted':'started';if(state.mode==='crash-return')throw Error('Return acknowledgement lost');stdout='OK';}
    else if(binary==='cmux'&&argv.includes('close-surface')){assert.equal(argv.at(-1),'owner');state.closes++;state.closed=true;stdout='OK';}
    else if(binary===process.execPath){const request=JSON.parse(options.input);stdout=JSON.stringify({thread:{id:request.threadId,cwd:root},queued:state.native==='queued'?[{clientUserMessageId:request.clientId}]:[],turns:['started','accepted'].includes(state.native)?[{id:'turn',status:'completed',items:[{type:'userMessage',id:'request',content:[{type:'text',text:prompt}]},...(state.native==='started'?[{type:'agentMessage',id:'response'},...(state.packetRead?[{type:'commandExecution',id:'read',status:'completed',exitCode:0,cwd:root,commandActions:[{type:'read',path:resultPath}],aggregatedOutput:content}]:[])]:[])]}]:[]});}
    else throw Error(`unexpected native command ${binary} ${argv}`);
    return {exitCode:0,stdout};
  };
  const run=async()=>{
    const cli=['unit','finalize','review','--state-root',root,'--project-root',root];
    const registered=await createRuntimeAdapters({cwd:root,adapters:{command},options:{'state-root':root},argv:cli});
    const output=await runUnitCli(cli,{stateRoot:root,cwd:root,adapters:{...createAdapters({sessionRunner:registered.sessionRunner,repositoryRoot:root}),command}});
    return JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));
  };
  return {root,state,run,rows,prompt,intent,resultPath};
}

test('public finalize resumes an unsubmitted empty delivery on its original seq despite prior unknown polls',async t=>{
  const f=await fixture(t);const results=await Promise.all([f.run(),f.run()]);assert.ok(results.every(r=>r.code===0),JSON.stringify(results));
  assert.equal((await f.run()).code,0);assert.equal(f.state.pastes,1);assert.equal(f.state.returns,1);assert.equal(f.state.closes,1);
  const rows=await f.rows();assert.deepEqual(rows.find(r=>r.event==='intent'&&r.seq===2),f.intent);
  for(const event of ['intent','submission','confirmation','result'])assert.equal(rows.filter(r=>r.seq===2&&r.event===event).length,1,event);
  assert.equal(rows.filter(r=>r.seq===2&&r.event==='verification'&&r.status==='unknown').length,45);
});

test('a fresh public delivery also records both durable boundaries before native effects',async t=>{
  const f=await fixture(t,{seed:false});assert.equal((await f.run()).code,0);assert.equal(f.state.pastes,1);assert.equal(f.state.returns,1);
  const rows=await f.rows();assert.equal(rows.find(r=>r.event==='intent').seq,1);assert.equal(rows.filter(r=>r.event==='submission').length,1);assert.equal(rows.filter(r=>r.event==='confirmation').length,1);
});

test('crash after submission or confirmation never repeats the consumed native input boundary',async t=>{
  for(const mode of ['crash-submission','crash-confirmation','crash-return'])await t.test(mode,async t=>{
    const f=await fixture(t);f.state.mode=mode;assert.equal((await f.run()).code,3);f.state.mode='normal';
    if(mode==='crash-return')f.state.native='ready';
    assert.equal((await f.run()).code,3);assert.equal((await f.run()).code,3);assert.equal(f.state.pastes,mode==='crash-submission'?0:1);assert.equal(f.state.returns,mode==='crash-return'?1:0);assert.equal(f.state.closes,0);
    assert.equal((await f.rows()).filter(r=>r.event==='submission').length,1);
  });
});

test('lost paste response resumes only exact pending text through its unused Return boundary',async t=>{
  const f=await fixture(t);f.state.mode='crash-paste';assert.equal((await f.run()).code,3);f.state.mode='normal';
  assert.equal((await f.run()).code,0);assert.equal((await f.run()).code,0);assert.equal(f.state.pastes,1);assert.equal(f.state.returns,1);assert.equal(f.state.closes,1);
});

test('draft, packet and queue changes during either durable checkpoint stop before its native effect',async t=>{
  for(const boundary of ['submission','confirmation'])for(const change of ['draft','packet','native'])await t.test(boundary+'-'+change,async t=>{
    const f=await fixture(t);f.state.mode=`boundary-${boundary}-${change}`;assert.equal((await f.run()).code,3);f.state.mode='normal';
    assert.notEqual((await f.run()).code,0);assert.equal(f.state.pastes,boundary==='submission'?0:1);assert.equal(f.state.returns,0);assert.equal(f.state.closes,0);
  });
});

test('an exact legacy pending reference uses durable confirmation without pasting again',async t=>{
  const f=await fixture(t,{pending:true});assert.equal((await f.run()).code,0);assert.equal(f.state.pastes,0);assert.equal(f.state.returns,1);
});

test('foreign draft, changed packet and changed native thread cannot resume a consumed paste',async t=>{
  for(const mode of ['foreign','packet','thread'])await t.test(mode,async t=>{
    const f=await fixture(t);f.state.mode='crash-paste';assert.equal((await f.run()).code,3);f.state.mode='normal';
    if(mode==='foreign')f.state.draft='human draft';if(mode==='packet')await writeFile(f.resultPath,'changed');if(mode==='thread')f.state.thread='00000000-0000-0000-0000-000000000003';
    assert.notEqual((await f.run()).code,0);assert.equal(f.state.pastes,1);assert.equal(f.state.returns,0);assert.equal(f.state.closes,0);
  });
});

test('queued, accepted and started delivery remain observation-only; native packet read is required',async t=>{
  for(const native of ['queued','accepted','started'])await t.test(native,async t=>{
    const f=await fixture(t);f.state.native=native;f.state.packetRead=false;assert.equal((await f.run()).code,3);assert.equal(f.state.pastes,0);assert.equal(f.state.returns,0);assert.equal(f.state.closes,0);
    if(native==='started'){f.state.packetRead=true;assert.equal((await f.run()).code,0);assert.equal(f.state.closes,1);}
  });
});


test('public finalize recognizes expanded hintless Ready on the original seq2 and refuses Working or nonempty drafts',async t=>{
  const f=await fixture(t,{expandedFooter:true});
  for(const status of ['Working','Unknown']){
    f.state.footerStatus=status;assert.equal((await f.run()).code,3);assert.equal(f.state.pastes,0);assert.equal(f.state.returns,0);
  }
  f.state.footerStatus='Ready';f.state.draft='foreign draft';assert.equal((await f.run()).code,3);assert.equal(f.state.pastes,0);
  f.state.draft='Ask Codex to do anything';assert.equal((await f.run()).code,0);assert.equal((await f.run()).code,0);
  assert.equal(f.state.pastes,1);assert.equal(f.state.returns,1);assert.equal(f.state.closes,1);
  const rows=await f.rows();assert.deepEqual(rows.find(r=>r.seq===2&&r.event==='intent'),f.intent);
  for(const event of ['intent','submission','confirmation','result'])assert.equal(rows.filter(r=>r.seq===2&&r.event===event).length,1);
});
