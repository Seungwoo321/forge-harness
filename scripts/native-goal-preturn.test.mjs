import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAdapters} from './lib/adapters.mjs';
import {createCodexTaskTransport} from './lib/codex-task.mjs';

test('real observer-manager errors combine with the owned queue store, never synthetic empty history',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'native-preturn-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const account=path.join(root,'account'),sqliteRoot=path.join(root,'sqlite');await mkdir(account);await mkdir(sqliteRoot);
 const threadId='11111111-1111-4111-8111-111111111111';
 const goalDb=new DatabaseSync(path.join(sqliteRoot,'goals_1.sqlite'));
 goalDb.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,created_at_ms INTEGER,updated_at_ms INTEGER)');goalDb.close();
 const queue=new DatabaseSync(path.join(sqliteRoot,'queue_1.sqlite'));
 queue.exec('CREATE TABLE queued_items(id TEXT PRIMARY KEY NOT NULL,thread_id TEXT NOT NULL,payload_json TEXT NOT NULL,queue_order INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)');
 t.after(()=>queue.close());
 const stateFile=path.join(root,'state.json'),trace=path.join(root,'trace.ndjson'),executable=path.join(root,'codex');
 const edit=state=>writeFile(stateFile,JSON.stringify(state));await edit({});
 await writeFile(executable,`#!/usr/bin/env node
const {readFileSync,appendFileSync}=require('node:fs');const readline=require('node:readline');
const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)}));
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!Object.hasOwn(r,'id'))return;
appendFileSync(${JSON.stringify(trace)},JSON.stringify(r)+'\\n');let result,error;
if(r.method==='initialize')result={codexHome:state.account||${JSON.stringify(account)},userAgent:'session_transport/'+(state.version||'0.167.0')+' (test)'};
else if(r.method==='thread/read'||r.method==='thread/turns/list')error={code:state.code||-32600,message:state.message||'thread not loaded: '+r.params.threadId};
else if(r.method==='thread/queue/list'){if(state.queueSuccess)result={data:[],nextCursor:null};else error={code:-32603,message:'failed to read thread: invalid thread-store request: no rollout found for thread id '+r.params.threadId};}
else throw Error('unexpected RPC '+r.method);
process.stdout.write(JSON.stringify({id:r.id,...(error?{error}:{result})})+'\\n');});
`,{mode:0o755});
 const core=createAdapters();let ownedRoot=sqliteRoot,changed=false,reads=0;
 const transport=createCodexTaskTransport({executable,env:{CODEX_HOME:account},command:(binary,args,options)=>{
  if(binary!=='lsof')return core.command(binary,args,options);
  reads++;return Promise.resolve({exitCode:0,stdout:`n${account}/thread-writer-locks/${changed&&reads%2===0?'22222222-2222-4222-8222-222222222222':threadId}.lock\nn${ownedRoot}/queue_1.sqlite\n`});
 }});
 const request={observed:{pid:42,cwd:root},input:{effect:'session.start',key:'original'},prompt:'finish',packets:[]};
 const proof=await transport.observeGoal(request);assert.equal(proof.state,'unmaterialized');assert.equal(proof.proof.sqliteRoot,sqliteRoot);
 assert.equal(proof.notApplied,undefined);assert.equal(proof.turns,undefined);assert.equal(proof.queued,undefined);
 queue.prepare('INSERT INTO queued_items VALUES(?,?,?,?,?,?)').run('other','22222222-2222-4222-8222-222222222222','{}',0,1,1);
 assert.equal((await transport.observeGoal(request)).state,'unmaterialized');
 queue.prepare('INSERT INTO queued_items VALUES(?,?,?,?,?,?)').run('own',threadId,'{}',0,1,1);
 await assert.rejects(transport.observeGoal(request),/history is unavailable/);queue.exec("DELETE FROM queued_items WHERE id='own'");
 for(const state of [{version:'0.168.0'},{account:'/foreign'},{code:-1},{message:'permission denied'},{message:'thread not loaded: foreign'},{queueSuccess:true}]) {
  await edit(state);await assert.rejects(transport.observeGoal(request),/history is unavailable/);
 }
 await edit({});ownedRoot=path.join(root,'missing');await assert.rejects(transport.observeGoal(request),/history is unavailable/);ownedRoot=sqliteRoot;
 changed=true;reads=0;await assert.rejects(transport.observeGoal(request),/worker thread changed/);changed=false;
 queue.exec('ALTER TABLE queued_items RENAME TO unsupported');await assert.rejects(transport.observeGoal(request),/history is unavailable/);
 const calls=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls.every(c=>['initialize','thread/read','thread/turns/list','thread/queue/list'].includes(c.method)));
});
