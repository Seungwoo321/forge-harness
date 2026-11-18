import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createSessionRunner } from './lib/session-runtime.mjs';

test('direct cmux launch registers its actual child TTY before exec and fails closed on registration errors', {skip:process.platform!=='darwin'}, async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'session-tty-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bin=path.join(root,'bin');await mkdir(bin);
 const worker=path.join(root,'worker.mjs');
 await writeFile(worker,"import {writeFileSync} from 'node:fs';writeFileSync(process.env.STARTED,'started');");
 await writeFile(path.join(bin,'cmux'),`#!${process.execPath}
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2),p=JSON.parse(args.at(-1));
writeFileSync(process.env.REPORT,JSON.stringify({args,p}));
if(process.env.MODE==='failed')process.exit(1);
console.log(JSON.stringify({...p,...(process.env.MODE==='wrong-target'?{surface_id:'other'}:{})}));
`,{mode:0o755});
 let text;
 const runner=createSessionRunner({runtime:'cmux',parent:{sessionId:'parent',incarnationId:'generation',cwd:root},launch:()=>[process.execPath,worker],pollAttempts:1,
  command:async(_binary,args)=>{text=args[args.indexOf('--command')+1];throw Error('captured launch');}});
 await assert.rejects(runner.execute({effect:'session.start',key:'key',args:{cwd:root}}),/captured launch/);
 for(const mode of ['success','failed','wrong-target','missing-target','no-tty']) {
  const report=path.join(root,mode+'.json'),started=path.join(root,mode+'.started');
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,MODE:mode,REPORT:report,STARTED:started,
   CMUX_WORKSPACE_ID:'11111111-1111-4111-8111-111111111111',CMUX_SURFACE_ID:mode==='missing-target'?'':'22222222-2222-4222-8222-222222222222'};
  const result=spawnSync(mode==='no-tty'?'/bin/sh':'/usr/bin/script',mode==='no-tty'?['-c',text]:['-q','/dev/null','/bin/sh','-c',text],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(mode==='success') {
   assert.equal(result.status,0,result.stderr+result.stdout);
   const {args,p}=JSON.parse(await readFile(report,'utf8'));
   assert.ok(args.includes('surface.report_tty'));
   assert.match(p.tty_name,/^ttys\d+$/);
   assert.equal(p.workspace_id,env.CMUX_WORKSPACE_ID);assert.equal(p.surface_id,env.CMUX_SURFACE_ID);
   assert.equal(await readFile(started,'utf8'),'started');
  } else await assert.rejects(readFile(started),{code:'ENOENT'});
 }
});
