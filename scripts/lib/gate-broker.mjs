import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const gateBrokerEnvironment = 'FORGE_GATE_BROKER';
// Environment data reaches the requested command only after native isolation applies.
export const brokerCommandBootstrap = `
const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const path=require('node:path');
let data='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>data+=chunk);
process.stdin.on('end',()=>{
  const {command,env,endpoint}=JSON.parse(data);
  const file=path.join(env.TMPDIR,'.broker-capability');
  writeFileSync(file,endpoint,{flag:'wx',mode:0o600});
  env.FORGE_GATE_BROKER=file;
  const child=spawn(command[0],command.slice(1),{env,stdio:['ignore','inherit','inherit']});
  child.on('error',error=>{console.error(error);process.exitCode=2});
  child.on('exit',(code,signal)=>{
    if(signal)process.kill(process.pid,signal);
    else process.exitCode=code??2;
  });
});`;

const invalid = message => Object.assign(new Error(message), {code:'GATE_BROKER_INVALID'});
const within = (root, value) => value === root || value.startsWith(`${root}${path.sep}`);
const location = async value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid('broker paths must be absolute');
  return realpath(value);
};

// The host owns this endpoint; requests supply no profile or host filesystem action.
export async function createGateBroker({root, outputs, runtimePaths, boundaries=[], execute}) {
  const token=randomUUID(), sockets=new Set(), pending=new Set();
  let closing=false;
  const scopes=new Map([[token,{root,outputs,runtimePaths,boundaries,pending:new Set(),closing:false}]]);
  const endpointFor=token=>JSON.stringify({port:server.address().port,token});
  const server=createServer({allowHalfOpen:true}, socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let bytes=0, chunks=[];
    socket.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>1024*1024){socket.destroy();return;}
      chunks.push(chunk);
    });
    socket.once('end',()=>{
      let owner;
      const task=(async()=>{
        try {
          if(closing) throw invalid('gate broker is closing');
          const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks=[];
          owner=scopes.get(request.token);
          if(!owner || owner.closing || !request.execution || typeof request.execution!=='object') throw invalid('unauthorized gate broker request');
          const input=request.execution;
          if(!Array.isArray(input.command) || !input.command.length || input.command.some(value=>typeof value!=='string' || !value || value.includes('\0'))
            || !Array.isArray(input.runtimePaths) || !Array.isArray(input.outputRoots)
            || !input.env || typeof input.env!=='object' || Array.isArray(input.env) || Object.entries(input.env).some(([key,value])=>key.includes('=') || key.includes('\0') || typeof value!=='string' || value.includes('\0'))) throw invalid('invalid captured gate command');
          const sourceRoot=await location(input.sourceRoot), snapshotRoot=await location(input.snapshotRoot), temporaryRoot=await location(input.temporaryRoot);
          if(!within(owner.root,sourceRoot) || !owner.outputs.some(output=>within(output,snapshotRoot)) || temporaryRoot!==path.join(snapshotRoot,'.forge-gate-tmp')) throw invalid('gate broker request escapes captured outputs');
          const tools=[];
          for(const value of input.runtimePaths){
            const tool=owner.runtimePaths.includes(value) ? value : await location(value);
            if(within(tool,sourceRoot) || !within(owner.root,tool) && !owner.runtimePaths.some(allowed=>within(allowed,tool))) throw invalid('gate broker runtime path exceeds captured tool locations');
            tools.push(tool);
          }
          const childOutputs=[];
          for(const value of input.outputRoots){
            const output=await location(value);
            if(output===snapshotRoot || !within(snapshotRoot,output))throw invalid('gate broker output escapes its snapshot');
            childOutputs.push(output);
          }
          if(!childOutputs.includes(temporaryRoot))throw invalid('gate broker temporary output is missing');
          const childToken=randomUUID();
          const childScope={root:snapshotRoot,outputs:childOutputs,runtimePaths:tools,
            boundaries:[...owner.boundaries,{root:snapshotRoot,tools,outputs:childOutputs,source:sourceRoot,secret:path.join(temporaryRoot,'.broker-capability')}],pending:new Set(),closing:false};
          scopes.set(childToken,childScope);
          let result;
          try{
            result=await execute({sourceRoot,snapshotRoot,temporaryRoot,runtimePaths:tools,command:input.command,env:input.env},endpointFor(childToken),owner.boundaries);
          }finally{
            childScope.closing=true;
            await Promise.allSettled([...childScope.pending]);
            scopes.delete(childToken);
          }
          socket.end(JSON.stringify({result:{...result,isolationBackend:'macos-sibling-sandbox-v1'}}));
        } catch(error){socket.end(JSON.stringify({error:{code:error.code ?? 'GATE_BROKER_INVALID',message:error.message}}));}
      })();
      pending.add(task);owner?.pending.add(task);
      const completed=()=>{pending.delete(task);owner?.pending.delete(task);};
      task.then(completed,completed);
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const endpoint=endpointFor(token);
  return {endpoint,async close(){
    closing=true;
    const closed=new Promise(resolve=>server.close(resolve));
    await Promise.allSettled([...pending]);
    for(const socket of sockets)socket.destroy();
    await closed;
  }};
}

export async function requestBrokerGate(endpoint, execution) {
  let address;
  try {address=JSON.parse(endpoint);} catch {throw invalid('invalid gate broker endpoint');}
  if(!Number.isInteger(address?.port) || address.port<1 || address.port>65535 || typeof address.token!=='string' || !address.token) throw invalid('invalid gate broker endpoint');
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port:address.port});
    const chunks=[];let completed=false;
    socket.on('error',reject);
    socket.once('close',()=>{if(!completed)reject(invalid('gate broker connection closed without a result'));});
    socket.once('connect',()=>socket.end(JSON.stringify({token:address.token,execution})));
    socket.on('data',chunk=>chunks.push(chunk));
    socket.once('end',()=>{
      completed=true;
      try {
        const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(response.error)throw Object.assign(new Error(response.error.message),{code:response.error.code});
        if(!response.result || typeof response.result.stdout!=='string' || typeof response.result.stderr!=='string'
          || !Number.isInteger(response.result.exitCode) && !response.result.signal)throw invalid('invalid gate broker execution result');
        resolve(response.result);
      } catch(error){reject(error);}
    });
  });
}
