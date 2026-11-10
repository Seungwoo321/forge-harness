import {link,mkdir,open,readFile,rm,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {acquireContinuityLock} from './continuity-lock.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createUnitStateStore} from './unit-state.mjs';

const hash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const fail=(message,code='LEGACY_FENCE_INVALID')=>{throw Object.assign(new Error(message),{code});};
const read=async file=>{try{return await readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function syncDir(file){const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
async function publish(file,bytes){const temp=`${file}.tmp-${randomUUID()}`;let f;try{f=await open(temp,'wx',0o600);await f.writeFile(bytes);await f.sync();await f.close();f=null;await link(temp,file);await syncDir(file);}finally{if(f)await f.close();await rm(temp,{force:true});}}
async function removeOwn(file,bytes){const before=await stat(file);if(!(await read(file))?.equals(bytes))fail('partial marker changed','CONTINUITY_STALE');const after=await stat(file);if(before.ino!==after.ino||before.dev!==after.dev)fail('partial marker replaced','CONTINUITY_STALE');await rm(file);await syncDir(file);}
async function claimOperation({dir,unit,requestDigest,guard,adapters}){
 if(typeof adapters?.processIdentity!=='function')fail('process identity observer is required','ADAPTER_MISSING');
 const identity=await adapters.processIdentity(process.pid);
 if(identity?.status!=='live'||typeof identity.incarnation!=='string'||!identity.incarnation)fail('operation identity is unproven','LEGACY_FENCE_UNPROVEN');
 const file=path.join(dir,'.legacy-fence.lease'),bytes=Buffer.from(`${JSON.stringify({schema:'harness.compound-fence-operation/1',unit,requestDigest,pid:process.pid,incarnation:identity.incarnation,token:randomUUID()})}\n`);
 guard.assertHeld();try{await publish(file,bytes);}catch(error){if(error.code==='EEXIST')fail('previous compound operation requires verified recovery','LEGACY_LEASE_RECOVERY_REQUIRED');throw error;}
 return async()=>{guard.assertHeld();if(!(await read(file))?.equals(bytes))fail('compound operation lease changed','CONTINUITY_STALE');await removeOwn(file,bytes);};
}

function assertFenceRequest(unit,request,userInputRef){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit??'')||['.','..'].includes(unit)||!request||Object.keys(request).sort().join(',')!=='expectedGoalRevision,expectedLedgerDigest,expectedRevision,id,provenance,reason'
  ||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id??'')||['.','..'].includes(request.id)||![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
  ||!digest(request.expectedLedgerDigest)||!path.isAbsolute(request.provenance?.path??'')||!digest(request.provenance?.digest)||Object.keys(request.provenance??{}).sort().join(',')!=='digest,path'
  ||typeof request.reason!=='string'||!request.reason.trim()||typeof userInputRef!=='string'||!userInputRef.trim())fail('exact fence request is required');
}

export async function preflightCompoundLegacyFence({stateRoot,unit,request,userInputRef,adapters}){
 assertFenceRequest(unit,request,userInputRef);
 if(typeof adapters?.provider?.verifyLegacyFence!=='function'||typeof adapters?.provider?.verifyCompoundFencePreflight!=='function'||typeof adapters?.processIdentity!=='function')
  fail('trusted fence preflight and native verifier are required','ADAPTER_MISSING');
 const root=path.resolve(stateRoot),store=createUnitStateStore(root),goals=createContinuityStore(root),record=await store.read(unit),goal=record?.continuity?.goalId?await goals.read(record.continuity.goalId):null;
 const ledger=await read(path.join(root,'units',unit,'ledger.ndjson')),source=await read(request.provenance.path);
 if(record?.state!=='Delivered'||record.revision!==request.expectedRevision||!record.accepted||!record.sessionFinalization?.owner||goal?.revision!==request.expectedGoalRevision||goal.goal?.status!=='active'||goal.goal.remaining?.[0]!==unit
  ||!ledger||hash(ledger)!==request.expectedLedgerDigest||!source||hash(source)!==request.provenance.digest)fail('fence preflight source changed','CONTINUITY_STALE');
 const rows=ledger.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(rows.some(row=>row.event==='intent'&&row.effect==='session.close'))fail('prior close needs reconciliation','EFFECT_UNCERTAIN');
 const binding={unit,stateRoot:root,goalId:goal.goal.id,userInputRef,argsDigest:effectArgsDigest({unit,request,userInputRef}),unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),ledgerDigest:hash(ledger),provenanceDigest:hash(source)};
 await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence',reason:request.reason});
 const proof=await adapters.provider.verifyCompoundFencePreflight({...binding,request:structuredClone(request),record:structuredClone(record),goal:structuredClone(goal)});
 if(proof?.verified!==true||proof.continuationReady!==true||Object.entries(binding).some(([key,value])=>proof[key]!==value))fail('fence preflight is unproven','LEGACY_FENCE_UNPROVEN');
 return {...binding,ready:true};
}

// A receipt is written only after both legacy writers are fenced and the host revalidates all evidence.
export async function establishCompoundLegacyFence({stateRoot,unit,request,userInputRef,adapters}){
 assertFenceRequest(unit,request,userInputRef);
 if(typeof adapters?.provider?.verifyLegacyFence!=='function'||typeof adapters?.provider?.verifyCompoundFencePreflight!=='function')fail('trusted fence preflight and native verifier are required','ADAPTER_MISSING');
 const root=path.resolve(stateRoot),dir=path.join(root,'units',unit),unitFile=path.join(dir,'.lock'),ledgerFile=path.join(dir,'.ledger.lock'),ledgerPath=path.join(dir,'ledger.ndjson');
 const store=createUnitStateStore(root),goals=createContinuityStore(root),requestDigest=effectArgsDigest({unit,request,userInputRef});
 await mkdir(dir,{recursive:true});const guard=await acquireContinuityLock(`${ledgerFile}.guard`);let release;
 try{
  release=await claimOperation({dir,unit,requestDigest,guard,adapters});
  if(await read(path.join(dir,`.compound-fence-cancel-${requestDigest.slice(7)}.json`)))fail('compound fence was cancelled','LEGACY_FENCE_CANCELLED');
  const record=await store.read(unit),goal=record?.continuity?.goalId?await goals.read(record.continuity.goalId):null,ledger=await read(ledgerPath),source=await read(request.provenance.path);
  if(record?.state!=='Delivered'||record.revision!==request.expectedRevision||!record.accepted||!record.sessionFinalization?.owner||goal?.revision!==request.expectedGoalRevision
    ||goal.goal?.status!=='active'||goal.goal.remaining?.[0]!==unit||!ledger||hash(ledger)!==request.expectedLedgerDigest||!source||hash(source)!==request.provenance.digest)fail('fence source changed','CONTINUITY_STALE');
  const rows=ledger.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(rows.some(row=>row.event==='intent'&&row.effect==='session.close'))fail('prior close needs reconciliation','EFFECT_UNCERTAIN');
  const binding={unit,stateRoot:root,goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),ledgerDigest:hash(ledger),provenanceDigest:hash(source)};
  await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence',reason:request.reason});
  const preflight=await adapters.provider.verifyCompoundFencePreflight({...binding,request:structuredClone(request),record:structuredClone(record),goal:structuredClone(goal)});
  if(preflight?.verified!==true||preflight.continuationReady!==true||Object.entries(binding).some(([key,value])=>preflight[key]!==value))
   fail('fence preflight is unproven','LEGACY_FENCE_UNPROVEN');
  const intentFile=path.join(dir,`.compound-fence-${requestDigest.slice(7)}.json`);let intentBytes=await read(intentFile),intent;
  if(intentBytes){try{intent=JSON.parse(intentBytes);}catch{fail('fence intent corrupt','CONTINUITY_STALE');}if(intent.requestDigest!==requestDigest||effectArgsDigest(intent.binding)!==effectArgsDigest(binding))fail('fence intent changed','CONTINUITY_STALE');}
  else{const token=randomUUID(),marker={protocol:'harness.legacy-fence/1',purpose:'legacy-fence',pid:process.pid,unit,stateRoot:root,goalId:goal.goal.id,requestDigest,token};intent={schema:'harness.compound-fence-intent/1',requestDigest,binding,marker};intentBytes=Buffer.from(`${JSON.stringify(intent)}\n`);guard.assertHeld();await publish(intentFile,intentBytes);}
  const bytes=Buffer.from(`${JSON.stringify(intent.marker)}\n`);
  const acquire=async file=>{const current=await read(file);if(current){if(!current.equals(bytes))fail('legacy lock is held by another owner','LEGACY_LOCK_BUSY');return;}guard.assertHeld();try{await publish(file,bytes);}catch(error){if(error.code==='EEXIST')fail('legacy lock is held by another owner','LEGACY_LOCK_BUSY');throw error;}};
  await acquire(unitFile);
  try{await acquire(ledgerFile);}catch(error){if(error.code==='LEGACY_LOCK_BUSY'){guard.assertHeld();if(!(await read(path.join(dir,`.legacy-fence-${requestDigest.slice(7)}.json`))))await removeOwn(unitFile,bytes);}throw error;}
  let result;await goals.transaction(goal.goal.id,async current=>{
   if(effectArgsDigest(current)!==binding.goalDigest||effectArgsDigest(await store.read(unit))!==binding.unitDigest||!(await read(ledgerPath))?.equals(ledger)||!(await read(request.provenance.path))?.equals(source))fail('fenced sources changed','CONTINUITY_STALE');
   const markerDigest=hash(bytes),unitMarkerDigest=hash(bytes),owner=record.sessionFinalization.owner;
   const proof=await adapters.provider.verifyLegacyFence({...binding,markerDigest,unitMarkerDigest,marker:intent.marker,unitMarker:intent.marker,record:structuredClone(record),goal:structuredClone(goal),ledger:ledger.toString('utf8'),owner:structuredClone(owner),request:structuredClone(request)});
   if(proof?.verified!==true||proof.ownerAlive!==true||proof.deliveryVerified!==true||proof.queueSettled!==true||proof.unitMarkerDigest!==unitMarkerDigest||proof.evidenceDigest!==binding.provenanceDigest
    ||Object.entries({...binding,markerDigest}).some(([key,value])=>proof[key]!==value)||['sessionId','incarnationId','cwd'].some(key=>proof.owner?.[key]!==owner[key]))fail('compound fence evidence is unproven','LEGACY_FENCE_UNPROVEN');
   guard.assertHeld();if(!(await read(unitFile))?.equals(bytes)||!(await read(ledgerFile))?.equals(bytes)||!(await read(ledgerPath))?.equals(ledger)
    ||!(await read(request.provenance.path))?.equals(source)||effectArgsDigest(await store.read(unit))!==binding.unitDigest)fail('fence changed','CONTINUITY_STALE');
   const receipt={schema:'harness.legacy-fence-receipt/1',unit,goalId:goal.goal.id,request,userInputRef,requestDigest,markerDigest,unitMarkerDigest,binding,proof,snapshot:{record,goal,ledger:ledger.toString('utf8')}};
   const receiptFile=path.join(dir,`.legacy-fence-${requestDigest.slice(7)}.json`),receiptBytes=Buffer.from(`${JSON.stringify(receipt)}\n`),prior=await read(receiptFile);
   if(prior&&!prior.equals(receiptBytes))fail('fence receipt differs','LEGACY_FENCE_CONFLICT');if(!prior)await publish(receiptFile,receiptBytes);
   result={unit,requestDigest,markerDigest,unitMarkerDigest};return current;
  });
  return result;
 }finally{try{if(release)await release();}finally{await guard.close();}}
}

// A partial publication is cancelled only with a fresh, exact observation of every unresolved effect.
export async function recoverPartialCompoundFence({stateRoot,unit,request,userInputRef,adapters}){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit??'')||['.','..'].includes(unit)||!request||Object.keys(request).sort().join(',')!=='evidence,fenceDigest,id,reason'
  ||!digest(request.fenceDigest)||!path.isAbsolute(request.evidence?.path??'')||!digest(request.evidence?.digest)
  ||Object.keys(request.evidence??{}).sort().join(',')!=='digest,path'||typeof request.id!=='string'||!request.id.trim()||typeof request.reason!=='string'||!request.reason.trim()||!userInputRef)
  fail('exact partial fence recovery request is required');
 if(typeof adapters?.provider?.verifyPartialFenceRecovery!=='function')fail('trusted partial recovery verifier is required','ADAPTER_MISSING');
 const root=path.resolve(stateRoot),dir=path.join(root,'units',unit),unitFile=path.join(dir,'.lock'),ledgerFile=path.join(dir,'.ledger.lock'),ledgerPath=path.join(dir,'ledger.ndjson');
 const intentFile=path.join(dir,`.compound-fence-${request.fenceDigest.slice(7)}.json`),receiptFile=path.join(dir,`.legacy-fence-${request.fenceDigest.slice(7)}.json`),leaseFile=path.join(dir,'.legacy-fence.lease');
 const guard=await acquireContinuityLock(`${ledgerFile}.guard`);let release;
 try{
  release=await claimOperation({dir,unit,requestDigest:effectArgsDigest({unit,request,userInputRef}),guard,adapters});
  const intentBytes=await read(intentFile);if(!intentBytes)fail('partial fence intent missing','CONTINUITY_STALE');
  const intent=JSON.parse(intentBytes),markerBytes=Buffer.from(`${JSON.stringify(intent.marker)}\n`);
  if(intent.schema!=='harness.compound-fence-intent/1'||intent.requestDigest!==request.fenceDigest||intent.marker?.requestDigest!==request.fenceDigest
    ||intent.marker?.unit!==unit||intent.marker?.stateRoot!==root)fail('partial fence identity changed','CONTINUITY_STALE');
  if(await read(receiptFile))fail('published fence cannot be cancelled as partial','CONTINUITY_STALE');
  const recoveryDigest=effectArgsDigest({unit,request,userInputRef}),recoveryFile=path.join(dir,`.compound-fence-recovery-${recoveryDigest.slice(7)}.json`);
  const preliminary={unit,stateRoot:root,userInputRef,argsDigest:recoveryDigest,effect:'unit.legacy-fence.partial-recover',reason:request.reason};
  await verifyApprovalInput(adapters.provider,preliminary);
  let unitMarker=await read(unitFile),ledgerMarker=await read(ledgerFile),ownedUnit=Boolean(unitMarker?.equals(markerBytes)),ownedLedger=Boolean(ledgerMarker?.equals(markerBytes));
  if(!ownedUnit&&!ownedLedger){
   const savedBytes=await read(recoveryFile);if(!savedBytes)fail('partial fence marker missing','CONTINUITY_STALE');
   const saved=JSON.parse(savedBytes),binding={...preliminary,phase:'confirm-release',fenceDigest:request.fenceDigest,recoveryDigest:hash(savedBytes),markerDigest:hash(markerBytes)};
   if(saved.schema!=='harness.partial-fence-recovery/1'||saved.argsDigest!==recoveryDigest||saved.fenceDigest!==request.fenceDigest||saved.markerDigest!==hash(markerBytes))fail('recovery record differs','CONTINUITY_STALE');
   const proof=await adapters.provider.verifyPartialFenceRecovery({...binding,recovery:structuredClone(saved),request:structuredClone(request)});
   if(proof?.verified!==true||proof.released!==true||Object.entries(binding).some(([key,value])=>proof[key]!==value))fail('partial fence release is unproven','LEGACY_FENCE_UNPROVEN');
   return {unit,fenceDigest:request.fenceDigest,released:true,duplicate:true};
  }
  if(unitMarker&&!ownedUnit||ledgerMarker&&!ownedLedger)fail('another legacy owner holds a fence lock','LEGACY_LOCK_BUSY');
  if(!ownedUnit){guard.assertHeld();try{await publish(unitFile,markerBytes);}catch(error){if(error.code==='EEXIST')fail('unit lock is busy','LEGACY_LOCK_BUSY');throw error;}unitMarker=markerBytes;ownedUnit=true;}
  if(!ownedLedger){guard.assertHeld();try{await publish(ledgerFile,markerBytes);}catch(error){if(error.code==='EEXIST')fail('ledger lock is busy','LEGACY_LOCK_BUSY');throw error;}ledgerMarker=markerBytes;ownedLedger=true;}
  const store=createUnitStateStore(root),goals=createContinuityStore(root);let result;
  await goals.transaction(intent.binding.goalId,async goal=>{
  const record=await store.read(unit),ledger=await read(ledgerPath),evidence=await read(request.evidence.path);
  if(!record||!goal||!ledger||!evidence||hash(evidence)!==request.evidence.digest||(goal.transfers??[]).some(item=>item.unit===unit&&item.deliveredContinuation))fail('partial recovery evidence changed','CONTINUITY_STALE');
  const rows=ledger.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const effects=rows.filter(row=>row.event==='intent'&&!rows.some(result=>result.event==='result'&&result.seq===row.seq&&result.key===row.key&&!['unknown','uncertain'].includes(result.result?.status)))
   .map(row=>({effect:row.effect,key:row.key,seq:row.seq,intentDigest:effectArgsDigest(row)}));
  const binding={unit,stateRoot:root,userInputRef,argsDigest:effectArgsDigest({unit,request,userInputRef}),fenceDigest:request.fenceDigest,intentDigest:hash(intentBytes),unitMarkerDigest:unitMarker?hash(unitMarker):null,
   ledgerMarkerDigest:ledgerMarker?hash(ledgerMarker):null,unitDigest:effectArgsDigest(record),goalDigest:effectArgsDigest(goal),ledgerDigest:hash(ledger),evidenceDigest:hash(evidence),effects};
  await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence.partial-recover',reason:request.reason});
  const proof=await adapters.provider.verifyPartialFenceRecovery({...binding,request:structuredClone(request),intent:structuredClone(intent),record:structuredClone(record),goal:structuredClone(goal),ledger:ledger.toString('utf8')});
  if(proof?.verified!==true||proof.safeToRelease!==true||proof.ownersFenced!==true||Object.entries(binding).some(([key,value])=>effectArgsDigest(proof[key]??null)!==effectArgsDigest(value??null))
    ||!Array.isArray(proof.externalEffects)||proof.externalEffects.length!==effects.length||effects.some(effect=>!proof.externalEffects.some(item=>item.effect===effect.effect&&item.key===effect.key&&item.seq===effect.seq&&item.intentDigest===effect.intentDigest&&['completed','not-applied'].includes(item.status))))
    fail('partial fence recovery is unproven','LEGACY_FENCE_UNPROVEN');
  const cancelFile=path.join(dir,`.compound-fence-cancel-${request.fenceDigest.slice(7)}.json`),cancelBytes=Buffer.from(`${JSON.stringify({schema:'harness.compound-fence-cancel/1',fenceDigest:request.fenceDigest})}\n`),cancel=await read(cancelFile);
  if(cancel&&!cancel.equals(cancelBytes))fail('cancellation record differs','CONTINUITY_STALE');
  if(!cancel){guard.assertHeld();await publish(cancelFile,cancelBytes);}
  const previousRecovery=await read(recoveryFile);
  if(previousRecovery){const saved=JSON.parse(previousRecovery);if(saved.argsDigest!==recoveryDigest||saved.fenceDigest!==request.fenceDigest||saved.markerDigest!==hash(markerBytes))fail('recovery record differs','CONTINUITY_STALE');}
  else {const saved={schema:'harness.partial-fence-recovery/1',argsDigest:recoveryDigest,fenceDigest:request.fenceDigest,markerDigest:hash(markerBytes),binding,proof};guard.assertHeld();await publish(recoveryFile,Buffer.from(`${JSON.stringify(saved)}\n`));}
  guard.assertHeld();if(!(await read(intentFile))?.equals(intentBytes)||await read(receiptFile)||!(await read(ledgerPath))?.equals(ledger)||!(await read(request.evidence.path))?.equals(evidence)
   ||effectArgsDigest(await store.read(unit))!==binding.unitDigest||effectArgsDigest(await goals.read(intent.binding.goalId))!==binding.goalDigest)fail('partial recovery inputs changed','CONTINUITY_STALE');
  if(ownedLedger)await removeOwn(ledgerFile,markerBytes);if(ownedUnit)await removeOwn(unitFile,markerBytes);
  result={unit,fenceDigest:request.fenceDigest,released:true};return goal;
  });
  return result;
 }finally{try{if(release)await release();}finally{await guard.close();}}
}

// Lost OS guards do not retire an operation while its original process is alive.
export async function recoverCompoundOperationLease({stateRoot,unit,request,userInputRef,adapters}){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit??'')||['.','..'].includes(unit)||!request||Object.keys(request).sort().join(',')!=='evidence,id,leaseDigest,reason'
  ||!digest(request.leaseDigest)||!path.isAbsolute(request.evidence?.path??'')||!digest(request.evidence?.digest)||Object.keys(request.evidence??{}).sort().join(',')!=='digest,path'
  ||typeof request.reason!=='string'||!request.reason.trim()||typeof userInputRef!=='string'||!userInputRef.trim())fail('exact operation lease recovery request is required');
 if(typeof adapters?.processIdentity!=='function'||typeof adapters?.provider?.verifyCompoundOperationRecovery!=='function'
  ||typeof adapters?.provider?.releaseCompoundOperationLease!=='function')fail('trusted operation recovery supervisor is required','ADAPTER_MISSING');
 const root=path.resolve(stateRoot),dir=path.join(root,'units',unit),file=path.join(dir,'.legacy-fence.lease'),ledgerFile=path.join(dir,'.ledger.lock'),unitFile=path.join(dir,'.lock');
 const guard=await acquireContinuityLock(`${ledgerFile}.guard`);
 try{
  const leaseBytes=await read(file),ledger=await read(path.join(dir,'ledger.ndjson')),unitMarker=await read(unitFile),ledgerMarker=await read(ledgerFile),evidence=await read(request.evidence.path);
  if(!ledger||!evidence||hash(evidence)!==request.evidence.digest)fail('operation recovery inputs changed','CONTINUITY_STALE');
  if(!leaseBytes||hash(leaseBytes)!==request.leaseDigest){
   const binding={unit,stateRoot:root,userInputRef,argsDigest:effectArgsDigest({unit,request,userInputRef}),leaseDigest:request.leaseDigest,evidenceDigest:hash(evidence),phase:'confirm-release'};
   await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence.operation-recover',reason:request.reason});
   const result=await adapters.provider.releaseCompoundOperationLease({...binding,request:structuredClone(request)});
   if(result?.verified!==true||result.released!==true||Object.entries(binding).some(([key,value])=>result[key]!==value))fail('operation lease release is unproven','LEGACY_FENCE_UNPROVEN');
   return {unit,leaseDigest:request.leaseDigest,released:true,duplicate:true};
  }
  const lease=JSON.parse(leaseBytes);if(lease.schema!=='harness.compound-fence-operation/1'||lease.unit!==unit||!Number.isSafeInteger(lease.pid)||lease.pid<1||!lease.incarnation)fail('operation lease malformed','CONTINUITY_STALE');
  const observed=await adapters.processIdentity(lease.pid);if(observed?.status!=='gone')fail('prior operation process is still live or unknown','LEGACY_LEASE_OWNER_UNFENCED');
  const rows=ledger.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const effects=rows.filter(row=>row.event==='intent'&&!rows.some(result=>result.event==='result'&&result.seq===row.seq&&result.key===row.key&&!['unknown','uncertain'].includes(result.result?.status)))
   .map(row=>({effect:row.effect,key:row.key,seq:row.seq,intentDigest:effectArgsDigest(row)}));
  const binding={unit,stateRoot:root,userInputRef,argsDigest:effectArgsDigest({unit,request,userInputRef}),leaseDigest:hash(leaseBytes),ledgerDigest:hash(ledger),evidenceDigest:hash(evidence),
   unitMarkerDigest:unitMarker?hash(unitMarker):null,ledgerMarkerDigest:ledgerMarker?hash(ledgerMarker):null,observed,effects};
  await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence.operation-recover',reason:request.reason});
  const proof=await adapters.provider.verifyCompoundOperationRecovery({...binding,lease:structuredClone(lease),request:structuredClone(request),ledger:ledger.toString('utf8')});
  if(proof?.verified!==true||proof.safeToRelease!==true||Object.entries(binding).some(([key,value])=>effectArgsDigest(proof[key]??null)!==effectArgsDigest(value??null))
   ||!Array.isArray(proof.externalEffects)||proof.externalEffects.length!==effects.length||effects.some(effect=>!proof.externalEffects.some(item=>item.effect===effect.effect&&item.key===effect.key&&item.seq===effect.seq&&item.intentDigest===effect.intentDigest&&['completed','not-applied'].includes(item.status))))
   fail('operation lease recovery is unproven','LEGACY_FENCE_UNPROVEN');
  guard.assertHeld();if(!(await read(file))?.equals(leaseBytes)||!(await read(path.join(dir,'ledger.ndjson')))?.equals(ledger)||!(await read(request.evidence.path))?.equals(evidence)
   ||!((await read(unitFile))??Buffer.alloc(0)).equals(unitMarker??Buffer.alloc(0))||!((await read(ledgerFile))??Buffer.alloc(0)).equals(ledgerMarker??Buffer.alloc(0))
   ||(await adapters.processIdentity(lease.pid))?.status!=='gone')fail('operation recovery inputs changed','CONTINUITY_STALE');
  const released=await adapters.provider.releaseCompoundOperationLease({...binding,lease:structuredClone(lease),request:structuredClone(request)});
  if(released?.verified!==true||released.released!==true||Object.entries(binding).some(([key,value])=>effectArgsDigest(released[key]??null)!==effectArgsDigest(value??null)))
    fail('supervised operation lease release is unproven','LEGACY_FENCE_UNPROVEN');
  return {unit,leaseDigest:request.leaseDigest,released:true};
 }finally{await guard.close();}
}
