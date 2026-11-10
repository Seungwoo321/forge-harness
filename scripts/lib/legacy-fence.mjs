import {appendFile,link,mkdir,open,readFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {effectArgsDigest,verifyApprovalInput} from './approvals.mjs';
import {acquireContinuityLock} from './continuity-lock.mjs';
import {createContinuityStore} from './continuity-store.mjs';
import {createUnitStateStore} from './unit-state.mjs';

const fail=(message,code='LEGACY_FENCE_INVALID')=>{throw Object.assign(new Error(message),{code});};
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const text=value=>typeof value==='string' && value.trim().length>0;
const digest=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const unitPath=unit=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit ?? '') || ['.','..'].includes(unit)) fail('invalid unit');return unit;};
async function read(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function publish(file,bytes){
  const temp=`${file}.tmp-${randomUUID()}`;let handle;
  try {handle=await open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await link(temp,file);
    const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
  finally {if(handle)await handle.close();await rm(temp,{force:true});}
}
function parseLedger(bytes){
  if (!bytes) return [];
  try{return bytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));}
  catch {fail('ledger is corrupt','LEDGER_CORRUPT');}
}
function paths(stateRoot,unit){const dir=path.resolve(stateRoot,'units',unitPath(unit));return {dir,lock:path.join(dir,'.ledger.lock'),ledger:path.join(dir,'ledger.ndjson'),lease:path.join(dir,'.legacy-fence.lease')};}

// The old CLI checks only the pid field of this permanent marker and never removes a lock it did not acquire.
export async function establishLegacyFence({stateRoot,unit,request,userInputRef,adapters}) {
  unitPath(unit);
  if (!request || Object.keys(request).sort().join(',')!=='expectedGoalRevision,expectedLedgerDigest,expectedRevision,id,provenance,reason'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || ![request.expectedRevision,request.expectedGoalRevision].every(n=>Number.isSafeInteger(n)&&n>0)
    || !digest(request.expectedLedgerDigest) || !path.isAbsolute(request.provenance?.path ?? '') || !digest(request.provenance?.digest)
    || Object.keys(request.provenance ?? {}).sort().join(',')!=='digest,path' || !text(request.reason) || !text(userInputRef))
    fail('exact unit and goal revisions, ledger digest, provenance and user authorization are required');
  if (typeof adapters?.provider?.verifyLegacyFence!=='function') fail('trusted native observer is required','ADAPTER_MISSING');
  const files=paths(stateRoot,unit),store=createUnitStateStore(stateRoot),goals=createContinuityStore(stateRoot);
  const requestDigest=effectArgsDigest({unit,request,userInputRef});
  await mkdir(files.dir,{recursive:true});
  const guard=await acquireContinuityLock(`${files.lock}.guard`);
  try {return await store.withLock(unit,async record=>{
    if (record.state!=='Delivered' || record.revision!==request.expectedRevision || !record.accepted || !record.sessionFinalization || !record.continuity?.goalId)
      fail('delivered unit changed','CONTINUITY_STALE');
    const owner=record.sessionFinalization.owner;
    if (!owner || !['sessionId','incarnationId','cwd'].every(k=>text(owner[k])) || !path.isAbsolute(owner.cwd)) fail('owner identity is incomplete');
    return goals.transaction(record.continuity.goalId,async goal=>{
      if (!goal || goal.revision!==request.expectedGoalRevision || goal.goal.status!=='active' || goal.goal.remaining[0]!==unit)
        fail('goal changed','CONTINUITY_STALE');
      const source=await readFile(request.provenance.path);
      if (hash(source)!==request.provenance.digest) fail('provenance changed','CONTINUITY_STALE');
      const ledger=await read(files.ledger);
      if (!ledger || hash(ledger)!==request.expectedLedgerDigest) fail('ledger changed','CONTINUITY_STALE');
      if (parseLedger(ledger).some(row=>row.event==='intent'&&row.effect==='session.close'))
        fail('prior close requires independent reconciliation','EFFECT_UNCERTAIN');
      const binding={unit,stateRoot:path.resolve(stateRoot),goalId:goal.goal.id,userInputRef,argsDigest:requestDigest,unitDigest:effectArgsDigest(record),
        goalDigest:effectArgsDigest(goal),ledgerDigest:request.expectedLedgerDigest,provenanceDigest:request.provenance.digest};
      await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-fence',reason:request.reason});
      const marker={protocol:'harness.legacy-fence/1',purpose:'legacy-fence',pid:process.pid,unit,stateRoot:path.resolve(stateRoot),goalId:goal.goal.id,requestDigest};
      let current=await read(files.lock);
      if (!current) {
        guard.assertHeld();
        try{await publish(files.lock,Buffer.from(`${JSON.stringify(marker)}\n`));}
        catch(e){if(e.code==='EEXIST')fail('an existing legacy ledger lock prevents fencing','LEDGER_LOCK_BUSY');throw e;}
        current=await read(files.lock);
      } else {
        let existing;try{existing=JSON.parse(current);}catch{fail('existing lock is not this fence','LEDGER_LOCK_BUSY');}
        if (existing.protocol!==marker.protocol || existing.purpose!==marker.purpose || existing.unit!==unit
          || existing.stateRoot!==path.resolve(stateRoot) || existing.goalId!==goal.goal.id || existing.requestDigest!==requestDigest || !Number.isSafeInteger(existing.pid) || existing.pid<1)
          fail('existing lock is not this fence','LEDGER_LOCK_BUSY');
      }
      const markerDigest=hash(current), proof=await adapters.provider.verifyLegacyFence({...binding,markerDigest,marker:JSON.parse(current),
        record:structuredClone(record),goal:structuredClone(goal),ledger:ledger.toString('utf8'),owner:structuredClone(owner),request:structuredClone(request)});
      if (proof?.verified!==true || Object.entries({...binding,markerDigest}).some(([k,v])=>proof[k]!==v)
        || proof.ownerAlive!==true || proof.deliveryVerified!==true || proof.queueSettled!==true
        || ['sessionId','incarnationId','cwd'].some(k=>proof.owner?.[k]!==owner[k]) || proof.evidenceDigest!==request.provenance.digest)
        fail('native delivery, queue or owner is unproven','LEGACY_FENCE_UNPROVEN');
      guard.assertHeld();
      if (!(await read(files.lock))?.equals(current) || !(await read(files.ledger))?.equals(ledger) || !(await readFile(request.provenance.path)).equals(source))
        fail('fence inputs changed during verification','CONTINUITY_STALE');
      const receipt={schema:'harness.legacy-fence-receipt/1',unit,goalId:goal.goal.id,request,userInputRef,requestDigest,markerDigest,binding,proof,
        snapshot:{record:structuredClone(record),goal:structuredClone(goal),ledger:ledger.toString('utf8')}};
      const receiptFile=path.join(files.dir,`.legacy-fence-${requestDigest.slice(7)}.json`),bytes=Buffer.from(`${JSON.stringify(receipt)}\n`);
      const existing=await read(receiptFile);
      if (existing && !existing.equals(bytes)) fail('fence receipt differs','LEGACY_FENCE_CONFLICT');
      if (!existing) await publish(receiptFile,bytes);
      return goal;
    }).then(async()=>({unit,requestDigest,markerDigest:hash(await read(files.lock))}));
  });} finally {await guard.close();}
}

// Only a verified lease may use the new advisory guard while leaving the old lock marker in place.
export function createLegacyFencedLedgerStore({stateRoot,unit,requestDigest,adapters}) {
  const files=paths(stateRoot,unit);
  if (!digest(requestDigest) || typeof adapters?.provider?.verifyLegacyFenceLease!=='function' || typeof adapters?.processIdentity!=='function') fail('trusted fence lease and process identity verifiers are required','ADAPTER_MISSING');
  return Object.freeze({async withLock(requested,action){
    if(requested!==unit)fail('lease is bound to another unit');
    const guard=await acquireContinuityLock(`${files.lock}.guard`);
    try {
      const marker=await read(files.lock),receiptBytes=await read(path.join(files.dir,`.legacy-fence-${requestDigest.slice(7)}.json`));
      if(!marker || !receiptBytes) fail('fence or receipt is missing','LEGACY_FENCE_UNPROVEN');
      let data,receipt;try{data=JSON.parse(marker);receipt=JSON.parse(receiptBytes);}catch{fail('fence or receipt is malformed','LEGACY_FENCE_UNPROVEN');}
      const binding={unit,stateRoot:path.resolve(stateRoot),requestDigest,goalId:data.goalId,markerDigest:hash(marker),receiptDigest:hash(receiptBytes)};
      if(data.protocol!=='harness.legacy-fence/1'||data.purpose!=='legacy-fence'||data.unit!==unit||data.stateRoot!==path.resolve(stateRoot)||data.requestDigest!==requestDigest
        || receipt.schema!=='harness.legacy-fence-receipt/1'||receipt.unit!==unit||receipt.goalId!==data.goalId||receipt.requestDigest!==requestDigest
        || receipt.markerDigest!==binding.markerDigest) fail('fence and receipt do not match','LEGACY_FENCE_UNPROVEN');
      const proof=await adapters.provider.verifyLegacyFenceLease({...binding,marker:data,receipt});
      if(proof?.verified!==true || Object.entries(binding).some(([k,v])=>proof[k]!==v)) fail('fence lease is unproven','LEGACY_FENCE_UNPROVEN');
      const reconcile=proof.mode==='reconcile'?proof.effect:null;
      if(!['normal','reconcile'].includes(proof.mode) || proof.mode==='reconcile' && (!reconcile
        || !['session.deliver','session.close','git.push'].includes(reconcile.effect) || !digest(reconcile.key) || !Number.isSafeInteger(reconcile.seq) || reconcile.seq<1))
        fail('fence lease mode is unproven','LEGACY_FENCE_UNPROVEN');
      if(await read(files.lease))fail('previous broker lease requires verified recovery','LEGACY_LEASE_RECOVERY_REQUIRED');
      const identity=await adapters.processIdentity(process.pid);
      if(identity?.status!=='live'||!text(identity.incarnation))fail('broker process incarnation is unavailable','LEGACY_FENCE_UNPROVEN');
      const lease=Buffer.from(`${JSON.stringify({schema:'harness.legacy-fence-lease/1',unit,requestDigest,pid:process.pid,incarnation:identity.incarnation,token:randomUUID()})}\n`);
      guard.assertHeld();await publish(files.lease,lease);
      const assertHeld=async()=>{guard.assertHeld();if(!(await read(files.lock))?.equals(marker)||!(await read(files.lease))?.equals(lease))fail('legacy fence or broker lease changed','LEGACY_FENCE_UNPROVEN');};
      try {await assertHeld();
        const rechecked=await adapters.provider.verifyLegacyFenceLease({...binding,marker:data,receipt});
        if(rechecked?.verified!==true||Object.entries(binding).some(([k,v])=>rechecked[k]!==v)||rechecked.mode!==proof.mode
          ||effectArgsDigest(rechecked.effect??null)!==effectArgsDigest(proof.effect??null)||rechecked.unitFenceVerified!==proof.unitFenceVerified)
          fail('fence lease changed after acquisition','LEGACY_FENCE_UNPROVEN');
        await assertHeld();
        const value=await action({reconcileOnly:Boolean(reconcile),fenceUserInputRef:receipt.userInputRef,fenceUnitDigest:receipt.binding?.unitDigest,fenceGoalDigest:receipt.binding?.goalDigest,async assertEffect({effect,key,phase}){
          if(reconcile && (phase!=='verify'||effect!==reconcile.effect||key!==reconcile.key))fail('lease permits only exact effect observation','LEGACY_LEASE_READ_ONLY');
        },async readRetainedUnit(){
          await assertHeld();const file=path.join(files.dir,'.lock'),unitMarker=await read(file);
          if(proof.unitFenceVerified!==true||!unitMarker||!digest(receipt.unitMarkerDigest)||receipt.proof?.unitMarkerDigest!==receipt.unitMarkerDigest
            ||hash(unitMarker)!==receipt.unitMarkerDigest)fail('unit fence is unproven','LEGACY_FENCE_UNPROVEN');
          let parsed;try{parsed=JSON.parse(unitMarker);}catch{fail('unit fence is malformed','LEGACY_FENCE_UNPROVEN');}
          if(parsed.protocol!=='harness.legacy-fence/1'||parsed.purpose!=='legacy-fence'||parsed.unit!==unit||parsed.stateRoot!==path.resolve(stateRoot)||parsed.requestDigest!==requestDigest)
            fail('unit fence does not match the ledger fence','LEGACY_FENCE_UNPROVEN');
          const record=await createUnitStateStore(stateRoot).read(unit);
          if(!record||effectArgsDigest(record)!==receipt.binding?.unitDigest||!(await read(file))?.equals(unitMarker))fail('retained unit changed','CONTINUITY_STALE');
          await assertHeld();return record;
        },async read(){await assertHeld();return parseLedger(await read(files.ledger));},async append(row){await assertHeld();
          if(reconcile && (!['result','verification'].includes(row.event)||row.seq!==reconcile.seq||row.key!==reconcile.key))
            fail('lease permits only exact effect reconciliation','LEGACY_LEASE_READ_ONLY');
          await appendFile(files.ledger,`${JSON.stringify(row)}\n`,{encoding:'utf8',mode:0o600,flag:'a'});const f=await open(files.ledger,'r+');try{await f.sync();}finally{await f.close();}}});
        await assertHeld();return value;
      } finally {await assertHeld();await rm(files.lease);}
    } finally {await guard.close();}
  }});
}

// A stale broker lease is retired only after its exact owner and every unfinished effect are observed.
export async function recoverLegacyFenceLease({stateRoot,unit,request,userInputRef,adapters}) {
  unitPath(unit);
  if (!request || Object.keys(request).sort().join(',')!=='evidence,id,leaseDigest,reason'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.id ?? '') || ['.','..'].includes(request.id)
    || !digest(request.leaseDigest) || !path.isAbsolute(request.evidence?.path ?? '') || !digest(request.evidence?.digest)
    || Object.keys(request.evidence ?? {}).sort().join(',')!=='digest,path' || !text(request.reason) || !text(userInputRef))
    fail('exact lease digest, evidence and authorization are required');
  if(typeof adapters?.provider?.verifyLegacyLeaseRecovery!=='function'||typeof adapters?.provider?.releaseCompoundOperationLease!=='function'||typeof adapters?.processIdentity!=='function')
    fail('trusted lease recovery supervisor and process identity verifiers are required','ADAPTER_MISSING');
  const files=paths(stateRoot,unit),guard=await acquireContinuityLock(`${files.lock}.guard`);
  try {
    const argsDigest=effectArgsDigest({unit,request,userInputRef}),receiptFile=path.join(files.dir,`.legacy-lease-recovery-${argsDigest.slice(7)}.json`);
    const marker=await read(files.lock),lease=await read(files.lease),saved=await read(receiptFile);
    if(!marker)fail('legacy fence is missing','LEGACY_FENCE_UNPROVEN');
    let mark;try{mark=JSON.parse(marker);}catch{fail('legacy fence is malformed','LEGACY_FENCE_UNPROVEN');}
    if(mark.protocol!=='harness.legacy-fence/1'||mark.purpose!=='legacy-fence'||mark.unit!==unit||mark.stateRoot!==path.resolve(stateRoot))
      fail('legacy fence does not match','LEGACY_FENCE_UNPROVEN');
    if(!lease||hash(lease)!==request.leaseDigest) {
      if(saved){const receipt=JSON.parse(saved);if(receipt.argsDigest===argsDigest&&receipt.leaseDigest===request.leaseDigest&&receipt.markerDigest===hash(marker)){
        const binding={unit,stateRoot:path.resolve(stateRoot),userInputRef,argsDigest,leaseDigest:request.leaseDigest,markerDigest:hash(marker),phase:'confirm-release'};
        const observed=await adapters.provider.releaseCompoundOperationLease({...binding,request:structuredClone(request)});
        if(observed?.verified===true&&observed.released===true&&Object.entries(binding).every(([k,v])=>observed[k]===v))return {...receipt,duplicate:true};
      }}
      fail('broker lease release is unproven','CONTINUITY_STALE');
    }
    let previous;try{previous=JSON.parse(lease);}catch{fail('broker lease is malformed');}
    if(previous.schema!=='harness.legacy-fence-lease/1'||previous.unit!==unit||previous.requestDigest!==mark.requestDigest
      ||!Number.isSafeInteger(previous.pid)||previous.pid<1||!text(previous.incarnation))fail('broker lease identity is incomplete');
    const observed=await adapters.processIdentity(previous.pid);
    if(observed?.status!=='gone')
      fail('previous broker remains live or its identity is unknown','LEGACY_LEASE_OWNER_UNFENCED');
    const evidence=await readFile(request.evidence.path);if(hash(evidence)!==request.evidence.digest)fail('recovery evidence changed','CONTINUITY_STALE');
    const ledger=await read(files.ledger),rows=parseLedger(ledger),unresolved=rows.filter(row=>{
      if(row.event!=='intent')return false;
      if(rows.some(mark=>(row.effect==='session.deliver'&&mark.event==='delivered-rework'||row.effect==='session.close'&&mark.event==='goal-completion-recovery')
        &&mark.seq===row.seq&&mark.key===row.key&&mark.intentDigest===effectArgsDigest(row)))return false;
      const latest=rows.findLast(result=>result.event==='result'&&result.seq===row.seq&&result.key===row.key);
      return !latest||['unknown','uncertain'].includes(latest.result?.status);
    });
    const effects=unresolved.map(row=>({seq:row.seq,key:row.key,effect:row.effect,intentDigest:effectArgsDigest(row)}));
    const binding={unit,stateRoot:path.resolve(stateRoot),userInputRef,argsDigest,request:structuredClone(request),leaseDigest:request.leaseDigest,markerDigest:hash(marker),
      ledgerDigest:ledger?hash(ledger):null,evidenceDigest:request.evidence.digest,previous,observed,effects};
    await verifyApprovalInput(adapters.provider,{...binding,effect:'unit.legacy-lease.recover',reason:request.reason});
    const proof=await adapters.provider.verifyLegacyLeaseRecovery(binding);
    if(proof?.verified!==true||proof.ownerFenced!==true||proof.legacyFenceIntact!==true
      ||Object.entries(binding).some(([k,v])=>effectArgsDigest(proof[k] ?? null)!==effectArgsDigest(v ?? null))
      ||!Array.isArray(proof.externalEffects)||proof.externalEffects.length!==effects.length
      ||effects.some(effect=>!proof.externalEffects.some(item=>item.seq===effect.seq&&item.key===effect.key&&item.intentDigest===effect.intentDigest
        &&['completed','not-applied'].includes(item.status)&&text(item.evidence))))
      fail('previous broker or external effects are unproven','LEGACY_LEASE_RECOVERY_UNPROVEN');
    guard.assertHeld();
    if(!(await read(files.lock))?.equals(marker)||!(await read(files.lease))?.equals(lease)
      ||!((await read(files.ledger))??Buffer.alloc(0)).equals(ledger??Buffer.alloc(0))||!(await readFile(request.evidence.path)).equals(evidence))
      fail('lease recovery inputs changed','CONTINUITY_STALE');
    const receipt={schema:'harness.legacy-lease-recovery/1',unit,argsDigest,leaseDigest:request.leaseDigest,markerDigest:hash(marker),binding,proof};
    if(saved){const prior=JSON.parse(saved);if(prior.argsDigest!==argsDigest||prior.leaseDigest!==request.leaseDigest)fail('lease recovery receipt differs','LEGACY_FENCE_CONFLICT');}
    else await publish(receiptFile,Buffer.from(`${JSON.stringify(receipt)}\n`));
    guard.assertHeld();if(!(await read(files.lease))?.equals(lease))fail('broker lease changed','CONTINUITY_STALE');
    const released=await adapters.provider.releaseCompoundOperationLease({...binding,lease:structuredClone(previous)});
    if(released?.verified!==true||released.released!==true||Object.entries(binding).some(([k,v])=>effectArgsDigest(released[k]??null)!==effectArgsDigest(v??null)))
      fail('supervised broker lease release is unproven','LEGACY_LEASE_RECOVERY_UNPROVEN');
    return receipt;
  } finally {await guard.close();}
}
