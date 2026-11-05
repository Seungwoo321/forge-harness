import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createClaudeTaskTransport} from './lib/claude-task.mjs';
import {taskDigest} from './lib/session-task.mjs';

test('Claude receipt requires exact process session, prompt, packet contents and descendant activity',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-task-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', project=path.join(root,'projects','project');await mkdir(project,{recursive:true});
 const file=path.join(project,`${id}.jsonl`), observed={pid:123,cwd:'/work',sessionId:'terminal',incarnationId:'inc'};
 const packet={path:'/goal',digest:taskDigest('goal'),content:'goal'},prompt=`Read ${packet.path} ${packet.digest}\n${packet.content}`;
 const input={effect:'session.start',key:'key',args:{cwd:'/work'}};
 let processId=id;
 const command=async ()=>({exitCode:0,stdout:`claude --session-id ${processId} prompt`});
 const transport=createClaudeTaskTransport({command,env:{CLAUDE_CONFIG_DIR:root}});
 const request={observed,input,prompt,packets:[packet]};
 assert.equal((await transport.observe(request)).state,'startup');
 const user={type:'user',sessionId:id,cwd:'/work',uuid:'user-1',message:{content:prompt}};
 await writeFile(file,JSON.stringify(user)+'\n'); assert.equal((await transport.observe(request)).state,'accepted');
 const assistant={type:'assistant',sessionId:id,uuid:'assistant-1',parentUuid:'user-1',message:{content:[{type:'text',text:'working'}]}};
 await writeFile(file,[user,assistant].map(JSON.stringify).join('\n')+'\n');
 const receipt=await transport.observe(request);assert.equal(receipt.state,'started');assert.equal(receipt.threadId,id);assert.deepEqual(receipt.packets,[{path:packet.path,digest:packet.digest}]);
 const short={...request,input:{...input,effect:'session.deliver'},prompt:'Read /goal'};
 const readUser={...user,message:{content:short.prompt}};
 const call={...assistant,message:{content:[{type:'tool_use',name:'Read',id:'tool-1',input:{file_path:'/goal'}}]}};
 await writeFile(file,[readUser,call].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'accepted');
 const result={type:'user',sessionId:id,uuid:'result-1',parentUuid:'assistant-1',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'1\tgoal'}]}};
 await writeFile(file,[readUser,call,result].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'started');
 // A delivery reaches an owner whose shell moved elsewhere; a start prompt must arrive at the launch cwd.
 await writeFile(file,[{...readUser,cwd:'/work/packages/a'},call,result].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'started');
 await writeFile(file,[{...user,cwd:'/work/packages/a'},assistant].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(request)).state,'startup');
 result.message.content[0].content='1\tchanged';
 await writeFile(file,[readUser,call,result].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'accepted');
 assert.deepEqual((await transport.observe({...request,prompt:'different'})).state,'startup');
 processId='ffffffff-1111-4222-8333-444444444444';assert.equal((await transport.observe(request)).state,'startup');
 processId=id;
 // A delivery sent while the owner is mid-turn arrives as a queued_command attachment injected into that turn.
 result.message.content[0].content='1\tgoal';
 const queued={type:'attachment',sessionId:id,uuid:'queued-1',parentUuid:'earlier',attachment:{type:'queued_command',commandMode:'prompt',prompt:short.prompt}};
 const queuedCall={...call,parentUuid:'queued-1'};
 await writeFile(file,[queued,queuedCall].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'accepted');
 await writeFile(file,[queued,queuedCall,result].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'started');
 // A queued start prompt is not a delivery and does not count.
 assert.equal((await transport.observe({...short,input})).state,'startup');
 // The same delivery re-sent as a normal turn after a queued copy that never read the packet still counts once.
 await writeFile(file,[queued,{...readUser,uuid:'user-2'},{...call,parentUuid:'user-2'},result].map(JSON.stringify).join('\n')+'\n');
 assert.equal((await transport.observe(short)).state,'started');
});

test('Claude native goal requires matching active status, command and descendant activity',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-goal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', project=path.join(root,'projects','project');await mkdir(project,{recursive:true});
 const file=path.join(project,`${id}.jsonl`), observed={pid:123,cwd:'/work'}, prompt='finish';
 const transport=createClaudeTaskTransport({command:async()=>({exitCode:0,stdout:`claude --session-id ${id}`}),env:{CLAUDE_CONFIG_DIR:root}});
 const common={sessionId:id,cwd:'/work'};
 const status={...common,type:'attachment',attachment:{type:'goal_status',met:false,sentinel:true,condition:prompt}};
 const command={...common,type:'user',uuid:'request',message:{content:`<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${prompt}</command-args>`}};
 const activity={...common,type:'assistant',uuid:'activity',parentUuid:'request',message:{content:[{type:'text',text:'working'}]}};
 const save=rows=>writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 const request={observed,prompt,packets:[]};
 await save([status,command]);assert.equal((await transport.observeGoal(request)).state,'accepted');
 await save([status,command,activity]);assert.equal((await transport.observeGoal(request)).activityId,'activity');
 const packet={path:'/work/handoff',content:'context',digest:taskDigest('context')};
 const read={...activity,uuid:'read',message:{content:[{type:'tool_use',name:'Read',id:'read-1',input:{file_path:packet.path}}]}};
 const result={...common,type:'user',uuid:'result',parentUuid:'read',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'1\tcontext'}]}};
 await save([status,command,read]);assert.equal((await transport.observeGoal({...request,packets:[packet]})).state,'accepted');
 await save([status,command,read,result]);assert.deepEqual((await transport.observeGoal({...request,packets:[packet]})).packets,[{path:packet.path,digest:packet.digest}]);
 const cleared={...common,type:'user',uuid:'clear',message:{content:'<local-command-stdout>Goal cleared: finish</local-command-stdout>'}};
 await save([status,command,activity,cleared]);await assert.rejects(transport.observeGoal(request),/cleared/);
 await save([status,command,{...activity,parentUuid:'other'}]);assert.equal((await transport.observeGoal(request)).state,'accepted');
 await save([status,command,activity,{...status,attachment:{type:'goal_status',met:true,condition:prompt}}]);
 assert.equal((await transport.observeGoal(request)).goal.status,'complete');
});

test('Claude packet reads count after the worker changes its shell directory; the goal command stays bound to the start cwd',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-goal-cwd-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', project=path.join(root,'projects','project');await mkdir(project,{recursive:true});
 const file=path.join(project,`${id}.jsonl`), observed={pid:123,cwd:'/work'}, prompt='finish';
 const transport=createClaudeTaskTransport({command:async()=>({exitCode:0,stdout:`claude --session-id ${id}`}),env:{CLAUDE_CONFIG_DIR:root}});
 const at=cwd=>({sessionId:id,cwd});
 const status={...at('/work'),type:'attachment',attachment:{type:'goal_status',met:false,condition:prompt}};
 const command={...at('/work'),type:'user',uuid:'request',message:{content:`<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${prompt}</command-args>`}};
 const moved={...at('/work/packages/a'),type:'assistant',uuid:'moved',parentUuid:'request',message:{content:[{type:'text',text:'cd packages/a'}]}};
 const packet={path:'/work/handoff',content:'context',digest:taskDigest('context')};
 const read={...at('/work/packages/a'),type:'assistant',uuid:'read',parentUuid:'moved',message:{content:[{type:'tool_use',name:'Read',id:'read-1',input:{file_path:packet.path}}]}};
 const result={...at('/work/packages/a'),type:'user',uuid:'result',parentUuid:'read',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'1\tcontext'}]}};
 const save=rows=>writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 await save([status,command,moved,read,result]);
 assert.equal((await transport.observeGoal({observed,prompt,packets:[packet]})).state,'started');
 await save([status,{...command,cwd:'/elsewhere'},moved,read,result]);
 await assert.rejects(transport.observeGoal({observed,prompt,packets:[packet]}),/missing or ambiguous/);
});
