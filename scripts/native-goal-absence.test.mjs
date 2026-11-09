import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCodexTaskTransport} from './lib/codex-task.mjs';
import {createAdapters} from './lib/adapters.mjs';

test('absent Codex goals read real native history and queue before authorizing same-intent recovery',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'native-absence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const database=new DatabaseSync(path.join(root,'goals_1.sqlite'));
 database.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,created_at_ms INTEGER,updated_at_ms INTEGER)');database.close();
 const threadId='11111111-1111-4111-8111-111111111111',stateFile=path.join(root,'native.json'),trace=path.join(root,'trace.ndjson'),executable=path.join(root,'codex');
 await writeFile(stateFile,JSON.stringify({turns:[],queued:[]}));
 await writeFile(executable,`#!/usr/bin/env node
const {readFileSync,appendFileSync}=require('node:fs');const readline=require('node:readline');
const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)}));
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!Object.hasOwn(r,'id'))return;
appendFileSync(${JSON.stringify(trace)},JSON.stringify(r)+'\\n');let result={};
if(r.method==='thread/read')result={thread:{id:${JSON.stringify(threadId)},cwd:${JSON.stringify(root)},source:'cli'}};
else if(r.method==='thread/turns/list')result={data:state.turns,nextCursor:null};
else if(r.method==='thread/queue/list'){if(state.queueError){process.stdout.write(JSON.stringify({id:r.id,error:{code:-1,message:'queue unavailable'}})+'\\n');return;}result={data:state.queued,nextCursor:null};}
else if(r.method==='hooks/list')result={data:[]};
else if(r.method!=='initialize')throw Error('unexpected native RPC '+r.method);
process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});
`,{mode:0o755});
 const core=createAdapters(),transport=createCodexTaskTransport({executable,env:{CODEX_HOME:root},
  command:(binary,args,options)=>binary==='lsof'?Promise.resolve({exitCode:0,stdout:`n${root}/thread-writer-locks/${threadId}.lock\n`}):core.command(binary,args,options)});
 const request={observed:{pid:42,cwd:root},input:{},prompt:'finish',packets:[]};
 const absent=await transport.observeGoal(request);assert.equal(absent.state,'absent');assert.equal(absent.notApplied,true);
 for(const state of [{turns:[{id:'old-goal',items:[]}],queued:[]},{turns:[],queued:[{input:'pending'}]}]) {
  await writeFile(stateFile,JSON.stringify(state));const pending=await transport.observeGoal(request);assert.equal(pending.state,'unknown');assert.equal(pending.notApplied,false);
 }
 await writeFile(stateFile,JSON.stringify({turns:[],queued:[],queueError:true}));await assert.rejects(transport.observeGoal(request),/native worker history/);
 const calls=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(c=>c.method==='thread/turns/list').length,4);assert.equal(calls.filter(c=>c.method==='thread/queue/list').length,4);
 assert.ok(calls.every(c=>['initialize','thread/read','thread/turns/list','thread/queue/list','hooks/list'].includes(c.method)));
});
