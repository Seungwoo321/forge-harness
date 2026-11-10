import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createUnitStateStore} from './lib/unit-state.mjs';
import {createContinuityStore} from './lib/continuity-store.mjs';
import {createLedgerStore} from './lib/ledger.mjs';
import {establishLegacyFence,createLegacyFencedLedgerStore} from './lib/legacy-fence.mjs';
import {continueDeliveredGoal} from './lib/delivered-continuation.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';
import {prepareEffect} from './lib/policy.mjs';
import {executeEffect} from './lib/ledger.mjs';
import {establishCompoundLegacyFence,recoverPartialCompoundFence,recoverCompoundOperationLease} from './lib/compound-legacy-fence.mjs';

async function fixture(t,{remaining=['u'],canonicalDelivery=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'legacy-fence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=createUnitStateStore(root), goals=createContinuityStore(root), ledger=createLedgerStore(root);
 const file=path.join(root,'source'),bytes='approved';await writeFile(file,bytes);
 const provenance={path:file,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
 await goals.create({goal:{id:'g',objective:'goal',criteria:['done'],remaining,status:'active'},policy:{runtime:'cmux',provider:'codex',account:'/account',model:'model',effort:'high',argv:['codex']},source:provenance});
 const owner={runtime:'cmux',sessionId:'owner',incarnationId:'owner-1',cwd:await realpath(root),worker:{executable:'/bin/codex',pid:42,incarnationId:'worker-inc',threadId:'owner-thread'}};
 await store.create({schema:'harness.unit/1',unit:'u',kind:'impl',state:'Delivered',continuity:{goalId:'g'},policy:{goal:{class:'product-prelaunch'},authority:{allow:[],deny:[]},delivery:'push'},accepted:{head:'old',contentFingerprint:'tree'},deliveryResult:{level:'push',head:'old'},sessionFinalization:{owner},acceptance:[],evidence:[],stages:[]});
 const deliveryArgs=canonicalDelivery?{session:'receiver',incarnation:'receiver-1',cwd:root,recipient:{sessionId:'receiver',incarnationId:'receiver-1',cwd:root},resultPath:file,resultDigest:provenance.digest}:{},deliveryKey=canonicalDelivery?prepareEffect('session.deliver',deliveryArgs).key:'old';
 await ledger.withLock('u',l=>l.append({event:'intent',effect:'session.deliver',seq:1,key:deliveryKey,args:deliveryArgs}));
 if(canonicalDelivery)await ledger.withLock('u',async l=>{
  const binding={runtime:'cmux',sessionId:'receiver',incarnationId:'receiver-1',cwd:root,executable:'codex',pid:22,threadId:'thread',promptDigest:`sha256:${'a'.repeat(64)}`,packets:[{path:file,digest:provenance.digest}]};
  await l.append({event:'submission',unit:'u',effect:'session.deliver',seq:1,key:deliveryKey,binding});
  await l.append({event:'confirmation',unit:'u',effect:'session.deliver',seq:1,key:deliveryKey,binding});
 });
 const ledgerBytes=await readFile(path.join(root,'units/u/ledger.ndjson'));
 const request={id:'fence',expectedRevision:1,expectedGoalRevision:1,expectedLedgerDigest:`sha256:${createHash('sha256').update(ledgerBytes).digest('hex')}`,provenance,reason:'authorized continuation'};
 const adapters={processIdentity:async pid=>({status:'live',incarnation:`test-${pid}`}),provider:{verifyUserInput:async x=>({...x,verified:true}),verifyCompoundFencePreflight:async x=>({...x,verified:true,continuationReady:true}),verifyLegacyFence:async x=>({...x,verified:true,ownerAlive:true,deliveryVerified:true,queueSettled:true,owner,evidenceDigest:provenance.digest}),verifyLegacyFenceLease:async x=>({...x,verified:true,mode:'normal'})}};
 const run=(changes={})=>establishLegacyFence({stateRoot:root,unit:'u',request,userInputRef:'user',adapters,...changes});
 return {root,store,goals,ledger,request,adapters,owner,run,deliveryArgs,deliveryKey};
}

test('delivered continuation preserves predecessor and adopts the exact successor once',async t=>{
 const f=await fixture(t,{remaining:['u','next'],canonicalDelivery:true});
 await f.store.update('u',record=>({...record,acceptance:[{id:'AC-1',text:'done'}],evidence:[{gate:'tests',exit:0,status:'passed',covers:['AC-1']}]}));
 f.request.expectedRevision=2;
 await f.store.create({schema:'harness.unit/1',unit:'next',kind:'impl',state:'Scoped',continuity:{goalId:'g'},head:'next-head',contentFingerprint:'next-tree',acceptance:[],evidence:[],stages:[]});
 const {runUnitCli}=await import('./lib/unit-driver.mjs'),file=path.join(f.root,'cli-request.json');
 const cli=async(name,request)=>{await writeFile(file,JSON.stringify(request));const output=await runUnitCli(['unit',name,'u','--request',file,'--user-input','user'],{cwd:f.root,stateRoot:f.root,adapters:f.adapters});return JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));};
 const fenced=await cli('delivered-fence',f.request);assert.equal(fenced.code,0);const fence=fenced.receipt;
 f.adapters.provider.verifyLegacyFenceLease=async binding=>({...binding,verified:true,unitFenceVerified:true,mode:'reconcile',effect:{effect:'session.deliver',key:f.deliveryKey,seq:1}});
 let sends=0;
 f.adapters.now=()=> 'time';f.adapters.session={execute:async()=>{sends++;},verify:async input=>({status:'completed',result:{sessionId:'receiver',incarnationId:'receiver-1',cwd:f.root,
  task:{schema:'harness.task-receipt/1',effectKey:input.key,sessionId:'receiver',incarnationId:'receiver-1',cwd:f.root,promptDigest:`sha256:${'a'.repeat(64)}`,threadId:'thread',requestId:'request',turnId:'turn',activityId:'activity',packets:[{path:f.deliveryArgs.resultPath,digest:f.deliveryArgs.resultDigest}]}}})};
 const reconciled=await cli('delivered-reconcile',{fenceDigest:fence.requestDigest});assert.equal(reconciled.code,0);assert.equal(reconciled.result.status,'reconciled');assert.equal(sends,0);
 f.adapters.provider.verifyLegacyFenceLease=async binding=>({...binding,verified:true,mode:'normal',unitFenceVerified:true});
 const owner=f.owner;
 const target={head:'next-head',contentFingerprint:'next-tree',repo:owner.cwd,branch:'deploy'};
 f.adapters.session.observe=async()=>owner;f.adapters.git={inspectUnit:async()=>target};
 f.adapters.provider.verifyDeliveredContinuation=async input=>({...input,verified:true,executionAccountVerified:true,targetVerified:true,originalDeliveryVerified:true});
 const prior=await f.store.read('u'),next=await f.store.read('next'),goal=await f.goals.read('g');
 const request={id:'continue',goalId:'g',successor:'next',unitDigest:effectArgsDigest(prior),successorDigest:effectArgsDigest(next),goalDigest:effectArgsDigest(goal),targetDigest:effectArgsDigest(target),fenceDigest:fence.requestDigest,owner,reason:'authorized follow-up'};
 const args={stateRoot:f.root,store:f.store,unit:'u',request,userInputRef:'user',adapters:f.adapters};
 f.adapters.session.observe=async()=>({...owner,incarnationId:'other'});
 await assert.rejects(continueDeliveredGoal(args),{code:'SESSION_OWNER_MISMATCH'});f.adapters.session.observe=async()=>owner;
 f.adapters.git.inspectUnit=async()=>({...target,head:'other'});
 await assert.rejects(continueDeliveredGoal(args),{code:'CONTINUITY_STALE'});f.adapters.git.inspectUnit=async()=>target;
 f.adapters.git.inspectUnit=async()=>({...target,repo:'/'});
 await assert.rejects(continueDeliveredGoal(args),{code:'CONTINUITY_STALE'});f.adapters.git.inspectUnit=async()=>target;
 f.adapters.provider.verifyDeliveredContinuation=async input=>({...input,verified:false});
 await assert.rejects(continueDeliveredGoal(args),{code:'CONTINUITY_UNPROVEN'});f.adapters.provider.verifyDeliveredContinuation=async input=>({...input,verified:true,executionAccountVerified:true,targetVerified:true,originalDeliveryVerified:true});
 const continued=await cli('delivered-continue',request);assert.equal(continued.code,0);const result=continued.result;
 assert.deepEqual(result.goal.remaining,['next']);assert.deepEqual(await f.store.read('u'),prior);assert.deepEqual(result.adoptions[0].owner,owner);
 const {validateGoalCompletion}=await import('./lib/continuity-completion.mjs');
 assert.equal(await validateGoalCompletion({continuity:result,unit:'next',proof:[{criterion:'done',unit:'u',acceptance:'AC-1'}],unitStore:f.store}),true);
 await f.store.update('next',record=>({...record,assumptions:['successor progressed']}));
 assert.equal((await continueDeliveredGoal(args)).revision,result.revision);
 assert.equal(JSON.parse(await readFile(path.join(f.root,'units/u/.lock'))).purpose,'legacy-fence');
});

test('legacy fence blocks an old ledger client and allows only a verified broker without removing the marker',async t=>{
 const f=await fixture(t),receipt=await f.run(),file=path.join(f.root,'units/u/.ledger.lock'),before=await readFile(file);
 const legacy=process.env.FORGE_LEGACY_LEDGER ?? new URL('./lib/ledger.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createLedgerStore} from ${JSON.stringify(legacy)};await createLedgerStore(process.argv[1]).withLock('u',async()=>process.stdout.write('ENTERED'));`,f.root],{stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',x=>out+=x);await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(child.exitCode,null);assert.equal(out,'');
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:receipt.requestDigest,adapters:f.adapters});
 await broker.withLock('u',l=>l.append({event:'audit',seq:2}));
 assert.equal((await broker.withLock('u',l=>l.read())).length,2);assert.deepEqual(await readFile(file),before);
});

test('unproven native observation leaves the fence in place and same request may be retried',async t=>{
 const f=await fixture(t),original=f.adapters.provider.verifyLegacyFence;
 f.adapters.provider.verifyLegacyFence=async x=>({...await original(x),queueSettled:false});
 await assert.rejects(f.run(),{code:'LEGACY_FENCE_UNPROVEN'});
 const marker=JSON.parse(await readFile(path.join(f.root,'units/u/.ledger.lock'),'utf8'));assert.equal(marker.purpose,'legacy-fence');
 f.adapters.provider.verifyLegacyFence=original;const receipt=await f.run();
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:receipt.requestDigest,adapters:f.adapters});
 assert.equal((await broker.withLock('u',l=>l.read())).length,1);
});

test('a prior close intent, stale state and false lease never grant ledger access',async t=>{
 const f=await fixture(t);await f.ledger.withLock('u',l=>l.append({event:'intent',effect:'session.close',seq:2,key:'close',args:{}}));
 f.request.expectedLedgerDigest=`sha256:${createHash('sha256').update(await readFile(path.join(f.root,'units/u/ledger.ndjson'))).digest('hex')}`;
 await assert.rejects(f.run(),{code:'EFFECT_UNCERTAIN'});
 const g=await fixture(t),receipt=await g.run();g.adapters.provider.verifyLegacyFenceLease=async x=>({...x,verified:false});
 const broker=createLegacyFencedLedgerStore({stateRoot:g.root,unit:'u',requestDigest:receipt.requestDigest,adapters:g.adapters});
 await assert.rejects(broker.withLock('u',l=>l.read()),{code:'LEGACY_FENCE_UNPROVEN'});
});

test('broker rejects verification that changes after durable lease acquisition',async t=>{
 const f=await fixture(t),receipt=await f.run();let calls=0,actions=0;
 f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:++calls===1,mode:'normal'});
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:receipt.requestDigest,adapters:f.adapters});
 await assert.rejects(broker.withLock('u',async()=>actions++),{code:'LEGACY_FENCE_UNPROVEN'});assert.equal(actions,0);assert.equal(calls,2);
});

test('a ledger fence alone does not prevent an old unit writer',async t=>{
 const f=await fixture(t);await f.run();
 const oldState=process.env.FORGE_LEGACY_UNIT_STATE;
 const store=oldState?(await import(oldState)).createUnitStateStore(f.root):f.store;
 await store.update('u',record=>({...record,assumptions:['legacy writer']}));
 assert.deepEqual((await f.store.read('u')).assumptions,['legacy writer']);
});

test('an exclusive unit marker blocks the old unit writer in isolation',async t=>{
 const f=await fixture(t),file=path.join(f.root,'units/u/.lock');
 const marker=JSON.stringify({pid:process.pid,protocol:'harness.legacy-fence/1',purpose:'legacy-fence'});
 await writeFile(file,marker,{flag:'wx'});
 const module=process.env.FORGE_LEGACY_UNIT_STATE??new URL('./lib/unit-state.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createUnitStateStore} from ${JSON.stringify(module)};await createUnitStateStore(process.argv[1]).update('u',r=>({...r,assumptions:['changed']}));process.stdout.write('UPDATED');`,f.root],{stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',chunk=>out+=chunk);await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(child.exitCode,null);assert.equal(out,'');
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 assert.equal(await readFile(file,'utf8'),marker);assert.equal((await f.store.read('u')).assumptions,undefined);
});

test('a dead unit marker owner still prevents the old unit writer',async t=>{
 const f=await fixture(t),file=path.join(f.root,'units/u/.lock');
 const markerOwner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await writeFile(file,JSON.stringify({pid:markerOwner.pid,protocol:'harness.legacy-fence/1',purpose:'legacy-fence'}),{flag:'wx'});
 const exited=new Promise(resolve=>markerOwner.once('exit',resolve));markerOwner.kill('SIGKILL');await exited;
 const module=process.env.FORGE_LEGACY_UNIT_STATE??new URL('./lib/unit-state.mjs',import.meta.url).href;
 const oldStore=(await import(module)).createUnitStateStore(f.root);
 await assert.rejects(oldStore.update('u',r=>({...r,assumptions:['changed']})),{code:'UNIT_LOCK_ORPHANED'});
 assert.equal((await f.store.read('u')).assumptions,undefined);
});

test('broker reads a retained unit only under its exact unit marker and receipt',async t=>{
 const f=await fixture(t),fence=await f.run(),broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 await assert.rejects(broker.withLock('u',ledger=>ledger.readRetainedUnit()),{code:'LEGACY_FENCE_UNPROVEN'});
 const unitMarker=Buffer.from(JSON.stringify({protocol:'harness.legacy-fence/1',purpose:'legacy-fence',pid:process.pid,unit:'u',stateRoot:f.root,requestDigest:fence.requestDigest}));
 const file=path.join(f.root,'units/u/.lock');await writeFile(file,unitMarker,{flag:'wx'});
 const receiptFile=path.join(f.root,'units/u',`.legacy-fence-${fence.requestDigest.slice(7)}.json`),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.unitMarkerDigest=`sha256:${createHash('sha256').update(unitMarker).digest('hex')}`;receipt.proof.unitMarkerDigest=receipt.unitMarkerDigest;await writeFile(receiptFile,JSON.stringify(receipt));
 f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:true,mode:'normal',unitFenceVerified:true});
 assert.equal((await broker.withLock('u',ledger=>ledger.readRetainedUnit())).state,'Delivered');
 await writeFile(file,'changed');
 await assert.rejects(broker.withLock('u',ledger=>ledger.readRetainedUnit()),{code:'LEGACY_FENCE_UNPROVEN'});
});

test('compound fence publishes both markers and the broker reads the retained unit',async t=>{
 const f=await fixture(t),run=()=>establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 const fence=await run();assert.deepEqual(await run(),fence);
 assert.equal(JSON.parse(await readFile(path.join(f.root,'units/u/.lock'))).purpose,'legacy-fence');
 assert.equal(JSON.parse(await readFile(path.join(f.root,'units/u/.ledger.lock'))).purpose,'legacy-fence');
 f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:true,mode:'normal',unitFenceVerified:true});
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 assert.equal((await broker.withLock('u',ledger=>ledger.readRetainedUnit())).state,'Delivered');
});

test('compound fence preflight refuses to publish when continuation is not ready',async t=>{
 const f=await fixture(t);f.adapters.provider.verifyCompoundFencePreflight=async input=>({...input,verified:true,continuationReady:false});
 await assert.rejects(establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters}),{code:'LEGACY_FENCE_UNPROVEN'});
 for(const name of ['.lock','.ledger.lock','.legacy-fence.lease'])await assert.rejects(readFile(path.join(f.root,'units/u',name)),{code:'ENOENT'});
});

test('public delivered-fence refuses missing trusted preflight without creating markers',async t=>{
 const f=await fixture(t),file=path.join(f.root,'fence-request.json');await writeFile(file,JSON.stringify(f.request));delete f.adapters.provider.verifyCompoundFencePreflight;
 const {runUnitCli}=await import('./lib/unit-driver.mjs');
 const output=await runUnitCli(['unit','delivered-fence','u','--request',file,'--user-input','user'],{cwd:f.root,stateRoot:f.root,adapters:f.adapters});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.notEqual(result.code,0);assert.equal(result.error,'ADAPTER_MISSING');
 for(const name of ['.lock','.ledger.lock','.legacy-fence.lease'])await assert.rejects(readFile(path.join(f.root,'units/u',name)),{code:'ENOENT'});
});

test('public delivered-preflight observes without creating markers or a lease',async t=>{
 const f=await fixture(t),file=path.join(f.root,'fence-request.json');await writeFile(file,JSON.stringify(f.request));
 const {runUnitCli}=await import('./lib/unit-driver.mjs');
 const output=await runUnitCli(['unit','delivered-preflight','u','--request',file,'--user-input','user'],{cwd:f.root,stateRoot:f.root,adapters:f.adapters});
 const result=JSON.parse(output.slice(output.lastIndexOf('RESULT ')+7));assert.equal(result.code,0);assert.equal(result.proof.ready,true);
 for(const bad of [{...f.request,id:'../invalid'},{...f.request,provenance:{...f.request.provenance,extra:true}}]){
  await writeFile(file,JSON.stringify(bad));const invalid=await runUnitCli(['unit','delivered-preflight','u','--request',file,'--user-input','user'],{cwd:f.root,stateRoot:f.root,adapters:f.adapters});
  assert.equal(JSON.parse(invalid.slice(invalid.lastIndexOf('RESULT ')+7)).error,'LEGACY_FENCE_INVALID');
 }
 for(const name of ['.lock','.ledger.lock','.legacy-fence.lease'])await assert.rejects(readFile(path.join(f.root,'units/u',name)),{code:'ENOENT'});
});

test('compound fence releases only its own unit marker when the ledger is busy',async t=>{
 const f=await fixture(t),lock=path.join(f.root,'units/u/.ledger.lock'),other=JSON.stringify({pid:process.pid});await writeFile(lock,other,{flag:'wx'});
 const run=()=>establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 await assert.rejects(run(),{code:'LEGACY_LOCK_BUSY'});assert.equal(await readFile(lock,'utf8'),other);
 await assert.rejects(readFile(path.join(f.root,'units/u/.lock')),{code:'ENOENT'});
 await rm(lock);assert.ok((await run()).unitMarkerDigest);
});

test('compound fence resumes after SIGKILL between both markers and receipt',async t=>{
 const f=await fixture(t),requestFile=path.join(f.root,'request.json');await writeFile(requestFile,JSON.stringify(f.request));
 const module=new URL('./lib/compound-legacy-fence.mjs',import.meta.url).href;
 const source=`import {readFile} from 'node:fs/promises';import {establishCompoundLegacyFence} from ${JSON.stringify(module)};const [root,file]=process.argv.slice(1),request=JSON.parse(await readFile(file,'utf8'));const adapters={processIdentity:async pid=>({status:'live',incarnation:'child-'+pid}),provider:{verifyUserInput:async x=>({...x,verified:true}),verifyCompoundFencePreflight:async x=>({...x,verified:true,continuationReady:true}),verifyLegacyFence:async()=>{process.stdout.write('VERIFYING\\n');await new Promise(()=>setInterval(()=>{},1000));}}};await establishCompoundLegacyFence({stateRoot:root,unit:'u',request,userInputRef:'user',adapters});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,f.root,requestFile],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const unitMarker=await readFile(path.join(f.root,'units/u/.lock')),ledgerMarker=await readFile(path.join(f.root,'units/u/.ledger.lock'));
 const lease=await readFile(path.join(f.root,'units/u/.legacy-fence.lease'));
 const recovery={id:'operation-recovery',leaseDigest:`sha256:${createHash('sha256').update(lease).digest('hex')}`,evidence:f.request.provenance,reason:'recover killed operation'};
 f.adapters.processIdentity=async pid=>pid===child.pid?{status:'gone'}:{status:'live',incarnation:`test-${pid}`};
 f.adapters.provider.verifyCompoundOperationRecovery=async input=>({...input,verified:true,safeToRelease:true,recoveryProcessFenced:true,externalEffects:input.effects.map(effect=>({...effect,status:'completed'}))});
 f.adapters.provider.releaseCompoundOperationLease=async input=>{if(input.phase!=='confirm-release')await rm(path.join(f.root,'units/u/.legacy-fence.lease'));return {...input,verified:true,released:true};};
 const recoveryArgs={stateRoot:f.root,unit:'u',request:recovery,userInputRef:'user',adapters:f.adapters};
 await recoverCompoundOperationLease(recoveryArgs);assert.equal((await recoverCompoundOperationLease(recoveryArgs)).duplicate,true);
 const newer=Buffer.from('newer lease');await writeFile(path.join(f.root,'units/u/.legacy-fence.lease'),newer,{flag:'wx'});
 assert.equal((await recoverCompoundOperationLease(recoveryArgs)).duplicate,true);assert.deepEqual(await readFile(path.join(f.root,'units/u/.legacy-fence.lease')),newer);
 await rm(path.join(f.root,'units/u/.legacy-fence.lease'));
 const fence=await establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 assert.equal(fence.unitMarkerDigest,`sha256:${createHash('sha256').update(unitMarker).digest('hex')}`);
 assert.deepEqual(await readFile(path.join(f.root,'units/u/.ledger.lock')),ledgerMarker);
});

test('operation lease recovery refuses a live or unproven original process',async t=>{
 const f=await fixture(t),file=path.join(f.root,'units/u/.legacy-fence.lease');
 const lease=Buffer.from(JSON.stringify({schema:'harness.compound-fence-operation/1',unit:'u',requestDigest:`sha256:${'a'.repeat(64)}`,pid:123,incarnation:'old',token:'t'}));
 await writeFile(file,lease,{flag:'wx'});
 const request={id:'operation-recovery',leaseDigest:`sha256:${createHash('sha256').update(lease).digest('hex')}`,evidence:f.request.provenance,reason:'recover'};
 f.adapters.provider.verifyCompoundOperationRecovery=async input=>({...input,verified:true,safeToRelease:true,recoveryProcessFenced:true,externalEffects:input.effects.map(effect=>({...effect,status:'completed'}))});
 f.adapters.provider.releaseCompoundOperationLease=async input=>({...input,verified:true,released:true});
 for(const observed of [{status:'live',incarnation:'different'},{status:'unknown'}]){
  f.adapters.processIdentity=async()=>observed;
  await assert.rejects(recoverCompoundOperationLease({stateRoot:f.root,unit:'u',request,userInputRef:'user',adapters:f.adapters}),{code:'LEGACY_LEASE_OWNER_UNFENCED'});
  assert.deepEqual(await readFile(file),lease);
 }
});

test('compound fence rejects provenance changed during native verification',async t=>{
 const f=await fixture(t),verify=f.adapters.provider.verifyLegacyFence;
 f.adapters.provider.verifyLegacyFence=async input=>{const proof=await verify(input);await writeFile(f.request.provenance.path,'changed');return proof;};
 await assert.rejects(establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters}),{code:'CONTINUITY_STALE'});
 const names=await (await import('node:fs/promises')).readdir(path.join(f.root,'units/u'));
 assert.equal(names.some(name=>name.startsWith('.legacy-fence-')&&name.endsWith('.json')),false);
});

test('partial compound fence recovery refuses unverified effects and preserves original state',async t=>{
 const f=await fixture(t);f.adapters.provider.verifyLegacyFence=async input=>({...input,verified:false});
 await assert.rejects(establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters}),{code:'LEGACY_FENCE_UNPROVEN'});
 const fenceDigest=effectArgsDigest({unit:'u',request:f.request,userInputRef:'user'}),before=await f.store.read('u');
 const request={id:'partial-recovery',fenceDigest,evidence:f.request.provenance,reason:'recover partial publication'};
 const args={stateRoot:f.root,unit:'u',request,userInputRef:'user',adapters:f.adapters};
 f.adapters.provider.verifyPartialFenceRecovery=async input=>({...input,verified:true,safeToRelease:true,ownersFenced:true,externalEffects:[]});
 await assert.rejects(recoverPartialCompoundFence(args),{code:'LEGACY_FENCE_UNPROVEN'});
 f.adapters.provider.verifyPartialFenceRecovery=async input=>input.phase==='confirm-release'?({...input,verified:true,released:true}):({...input,verified:true,safeToRelease:true,ownersFenced:true,externalEffects:input.effects.map(effect=>({...effect,status:'completed'}))});
 assert.equal((await recoverPartialCompoundFence(args)).released,true);
 await assert.rejects(readFile(path.join(f.root,'units/u/.lock')),{code:'ENOENT'});
 await assert.rejects(readFile(path.join(f.root,'units/u/.ledger.lock')),{code:'ENOENT'});
 assert.deepEqual(await f.store.read('u'),before);
 assert.equal((await recoverPartialCompoundFence(args)).duplicate,true);
 await assert.rejects(establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters}),{code:'LEGACY_FENCE_CANCELLED'});
});

test('a new approved recovery can continue an existing cancellation',async t=>{
 const f=await fixture(t);f.adapters.provider.verifyLegacyFence=async input=>({...input,verified:false});
 await assert.rejects(establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters}),{code:'LEGACY_FENCE_UNPROVEN'});
 const fenceDigest=effectArgsDigest({unit:'u',request:f.request,userInputRef:'user'}),cancel=path.join(f.root,'units/u',`.compound-fence-cancel-${fenceDigest.slice(7)}.json`);
 await writeFile(cancel,`${JSON.stringify({schema:'harness.compound-fence-cancel/1',fenceDigest})}\n`,{flag:'wx'});
 const request={id:'new-recovery',fenceDigest,evidence:f.request.provenance,reason:'new approved evidence'};
 f.adapters.provider.verifyPartialFenceRecovery=async input=>({...input,verified:true,safeToRelease:true,ownersFenced:true,externalEffects:input.effects.map(effect=>({...effect,status:'completed'}))});
 assert.equal((await recoverPartialCompoundFence({stateRoot:f.root,unit:'u',request,userInputRef:'new-user',adapters:f.adapters})).released,true);
});

test('a killed broker keeps the legacy fence and needs verified lease recovery',async t=>{
 const f=await fixture(t),receipt=await f.run(),markerFile=path.join(f.root,'units/u/.ledger.lock'),marker=await readFile(markerFile);
 const module=new URL('./lib/legacy-fence.mjs',import.meta.url).href;
 const source=`import {createLegacyFencedLedgerStore} from ${JSON.stringify(module)};const [root,digest]=process.argv.slice(1);const adapters={processIdentity:async pid=>({status:'live',incarnation:'child-'+pid}),provider:{verifyLegacyFenceLease:async x=>({...x,verified:true,mode:'normal'})}};await createLegacyFencedLedgerStore({stateRoot:root,unit:'u',requestDigest:digest,adapters}).withLock('u',async()=>{process.stdout.write('LEASED\\n');await new Promise(()=>setInterval(()=>{},1000));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,f.root,receipt.requestDigest],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const leaseFile=path.join(f.root,'units/u/.legacy-fence.lease'),lease=await readFile(leaseFile);
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:receipt.requestDigest,adapters:f.adapters});
 let error;
 for(let attempt=0;attempt<10;attempt++){try{await broker.withLock('u',l=>l.read());break;}catch(e){error=e;if(e.code==='LEGACY_LEASE_RECOVERY_REQUIRED')break;await new Promise(resolve=>setTimeout(resolve,30));}}
 assert.equal(error?.code,'LEGACY_LEASE_RECOVERY_REQUIRED');
 const {recoverLegacyFenceLease}=await import('./lib/legacy-fence.mjs');
 const request={id:'lease-recovery',leaseDigest:`sha256:${createHash('sha256').update(lease).digest('hex')}`,evidence:f.request.provenance,reason:'recover killed broker'};
 f.adapters.processIdentity=async pid=>pid===child.pid?{status:'gone'}:{status:'live',incarnation:`test-${pid}`};
 f.adapters.provider.verifyLegacyLeaseRecovery=async binding=>({...binding,verified:true,ownerFenced:true,legacyFenceIntact:true,externalEffects:binding.effects.map(effect=>({...effect,status:'completed',evidence:'observed'}))});
 f.adapters.provider.releaseCompoundOperationLease=async input=>{if(input.phase!=='confirm-release')await rm(leaseFile);return {...input,verified:true,released:true};};
 const result=await recoverLegacyFenceLease({stateRoot:f.root,unit:'u',request,userInputRef:'user',adapters:f.adapters});
 assert.equal(result.leaseDigest,request.leaseDigest);assert.deepEqual(await readFile(markerFile),marker);
 assert.equal((await broker.withLock('u',l=>l.read())).length,1);
 assert.equal((await recoverLegacyFenceLease({stateRoot:f.root,unit:'u',request,userInputRef:'user',adapters:f.adapters})).duplicate,true);
});

test('lease recovery refuses live or unproven owners and incomplete external-effect evidence',async t=>{
 const {recoverLegacyFenceLease}=await import('./lib/legacy-fence.mjs');
 for(const mode of ['live','unknown','approval','effects','proof']){
  const f=await fixture(t),receipt=await f.run(),leaseFile=path.join(f.root,'units/u/.legacy-fence.lease');
  const lease=Buffer.from(JSON.stringify({schema:'harness.legacy-fence-lease/1',unit:'u',requestDigest:receipt.requestDigest,pid:999,incarnation:'old',token:'t'}));await writeFile(leaseFile,lease);
  const request={id:'recovery',leaseDigest:`sha256:${createHash('sha256').update(lease).digest('hex')}`,evidence:f.request.provenance,reason:'recover'};
  f.adapters.processIdentity=async()=>mode==='live'?{status:'live',incarnation:'old'}:mode==='unknown'?{status:'unknown'}:{status:'gone'};
  f.adapters.provider.verifyUserInput=async x=>({...x,verified:mode!=='approval'});
  f.adapters.provider.verifyLegacyLeaseRecovery=async binding=>({...binding,verified:mode!=='proof',ownerFenced:true,legacyFenceIntact:true,
    externalEffects:mode==='effects'?[]:binding.effects.map(effect=>({...effect,status:'completed',evidence:'observed'}))});
  f.adapters.provider.releaseCompoundOperationLease=async input=>({...input,verified:true,released:true});
  await assert.rejects(recoverLegacyFenceLease({stateRoot:f.root,unit:'u',request,userInputRef:'user',adapters:f.adapters}));
  assert.deepEqual(await readFile(leaseFile),lease,mode);
 }
});

test('reconciliation lease observes only its exact intent and never starts a new effect',async t=>{
 const f=await fixture(t),fence=await f.run(),broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 const {executeEffect}=await import('./lib/ledger.mjs'),{prepareEffect}=await import('./lib/policy.mjs');
 const args={repo:'repo',branch:'branch',head:'new'},key=prepareEffect('git.push',args).key,seq=2;
 await broker.withLock('u',l=>l.append({event:'intent',unit:'u',effect:'git.push',seq,key,args}));
 f.adapters.provider.verifyLegacyFenceLease=async binding=>({...binding,verified:true,mode:'reconcile',effect:{effect:'git.push',key,seq}});
 let executed=0,verified=0;
 const adapter={now:()=> 'time',execute:async()=>{executed++;return {head:'new'};},verify:async input=>{verified++;assert.equal(input.reconcileOnly,true);return {status:'completed',result:{head:'new'}};}};
 const policy={goal:{class:'product-prelaunch'},authority:{allow:[],deny:[]},delivery:'push'};
 const input={unit:'u',effect:'git.push',args,policy,context:{productOwned:true,explicitUserInstruction:true},store:broker,adapter};
 const result=await executeEffect(input);assert.equal(result.status,'reconciled');assert.equal(verified,1);assert.equal(executed,0);
 await assert.rejects(executeEffect({...input,args:{...args,head:'different'}}),{code:'LEGACY_LEASE_READ_ONLY'});
 assert.equal(executed,0);
});

test('delivery reconciliation verifies the original intent without sending again',async t=>{
 const f=await fixture(t),fence=await f.run(),{executeEffect}=await import('./lib/ledger.mjs'),{prepareEffect}=await import('./lib/policy.mjs');
 const args={session:'receiver',incarnation:'receiver-1',resultDigest:`sha256:${'a'.repeat(64)}`},key=prepareEffect('session.deliver',args).key;
 const initial=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 await initial.withLock('u',ledger=>ledger.append({event:'intent',unit:'u',seq:2,effect:'session.deliver',key,args}));
 f.adapters.provider.verifyLegacyFenceLease=async binding=>({...binding,verified:true,mode:'reconcile',effect:{effect:'session.deliver',key,seq:2}});
 let executed=0,verified=0;
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 const adapter={now:()=> 'time',execute:async()=>{executed++;},verify:async input=>{verified++;assert.equal(input.reconcileOnly,true);return {status:'completed',result:{task:'received'}};}};
 const result=await executeEffect({unit:'u',effect:'session.deliver',args,policy:{goal:{class:'product-prelaunch'},authority:{allow:[],deny:[]},delivery:'push'},context:{productOwned:true,explicitUserInstruction:true},store:broker,adapter});
 assert.equal(result.status,'reconciled');assert.equal(executed,0);assert.equal(verified,1);
});

test('delivery reconciliation uses the retained intent and never executes delivery',async t=>{
 const f=await fixture(t,{canonicalDelivery:true}),fence=await establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 let mode='reconcile';f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:true,unitFenceVerified:true,mode,...(mode==='reconcile'?{effect:{effect:'session.deliver',key:f.deliveryKey,seq:1}}:{})});
 let executions=0,recipient='other',thread='thread';f.adapters.now=()=> 'time';f.adapters.session={execute:async()=>{executions++;},verify:async input=>({status:'completed',result:{sessionId:recipient,incarnationId:'receiver-1',cwd:f.root,
  task:{schema:'harness.task-receipt/1',effectKey:input.key,sessionId:recipient,incarnationId:'receiver-1',cwd:f.root,promptDigest:`sha256:${'a'.repeat(64)}`,threadId:thread,requestId:'request',turnId:'turn',activityId:'activity',packets:[{path:f.deliveryArgs.resultPath,digest:f.deliveryArgs.resultDigest}]}}})};
 const {reconcileLegacyDelivery}=await import('./lib/legacy-delivery-reconcile.mjs');
 assert.equal((await reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters})).status,'uncertain');recipient='receiver';thread='other';
 assert.equal((await reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters})).status,'uncertain');thread='thread';
 const result=await reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters});
 assert.equal(result.status,'reconciled');assert.equal(executions,0);
 mode='normal';assert.equal((await reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters})).status,'duplicate');
});

test('delivery reconciliation honors a unit policy denial',async t=>{
 const f=await fixture(t,{canonicalDelivery:true});await f.store.update('u',record=>({...record,policyOverrides:{authority:{deny:['session.deliver']}}}));f.request.expectedRevision=2;
 const fence=await establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:true,unitFenceVerified:true,mode:'reconcile',effect:{effect:'session.deliver',key:f.deliveryKey,seq:1}});
 let observations=0;f.adapters.now=()=> 'time';f.adapters.session={verify:async()=>{observations++;return {status:'unknown'};}};
 const {reconcileLegacyDelivery}=await import('./lib/legacy-delivery-reconcile.mjs');
 await assert.rejects(reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters}),{code:'EFFECT_DENIED'});assert.equal(observations,0);
});

test('delivery reconciliation rejects an existing receipt from a different thread',async t=>{
 const f=await fixture(t,{canonicalDelivery:true}),fence=await establishCompoundLegacyFence({stateRoot:f.root,unit:'u',request:f.request,userInputRef:'user',adapters:f.adapters});
 f.adapters.provider.verifyLegacyFenceLease=async input=>({...input,verified:true,unitFenceVerified:true,mode:'normal'});
 const broker=createLegacyFencedLedgerStore({stateRoot:f.root,unit:'u',requestDigest:fence.requestDigest,adapters:f.adapters});
 const result={sessionId:'receiver',incarnationId:'receiver-1',cwd:f.root,task:{schema:'harness.task-receipt/1',effectKey:f.deliveryKey,sessionId:'receiver',incarnationId:'receiver-1',cwd:f.root,
  promptDigest:`sha256:${'a'.repeat(64)}`,threadId:'different',requestId:'request',turnId:'turn',activityId:'activity',packets:[{path:f.deliveryArgs.resultPath,digest:f.deliveryArgs.resultDigest}]}};
 await broker.withLock('u',ledger=>ledger.append({event:'result',unit:'u',seq:1,key:f.deliveryKey,result}));
 f.adapters.now=()=> 'time';f.adapters.session={verify:async()=>({status:'unknown'})};
 const {reconcileLegacyDelivery}=await import('./lib/legacy-delivery-reconcile.mjs');
 await assert.rejects(reconcileLegacyDelivery({stateRoot:f.root,unit:'u',fenceDigest:fence.requestDigest,userInputRef:'user',adapters:f.adapters}),{code:'SESSION_TASK_UNVERIFIED'});
});
