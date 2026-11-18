import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner } from './lib/session-runtime.mjs';

test('Orca without a native process fence rejects the contract before creating a worker',async()=>{
 let launches=0;
 const runner=createSessionRunner({runtime:'orca',parent:{sessionId:'parent',incarnationId:'generation',cwd:'/project'},launch:()=>['worker'],pollAttempts:1,
  command:async(_binary,args)=>{
   if(args.includes('create'))launches++;
   return {exitCode:0,stdout:JSON.stringify({terminal:{handle:'parent',incarnationId:'generation',executionHostId:'local',connected:true,writable:true}})};
  },
  runtimeRpc:async()=>({process:{foregroundProcessEvidence:{verdict:'live',ptyId:'parent',ptyIncarnationId:'generation',authorityGeneration:'authority',observationEpoch:1,capturedAgeMs:0,
   fence:{platform:'posix',shellPid:1,shellStartTime:'START',tty:'ttys1',foregroundPgid:22}}}}),
 });
 const error=await runner.execute({effect:'session.start',key:'key',args:{cwd:'/project'}}).catch(error=>error);
 assert.equal(launches,0);
 assert.equal(error.code,'SESSION_CONTRACT_UNSUPPORTED');
 assert.match(error.message,/process fence/);
});
