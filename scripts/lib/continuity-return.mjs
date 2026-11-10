import { goalOwner, assertAdoptedOwner } from './continuity-custody.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContinuityStore } from './continuity-store.mjs';
import { snapshotGoal, snapshotText } from './continuity-snapshot.mjs';
import { createLedgerStore, sessionEffectRetired } from './ledger.mjs';
import { formatUnitResult, validateHandoffPacket } from './report.mjs';
import { effectArgsDigest } from './approvals.mjs';

const invalid = message => Object.assign(new Error(message), {code:'CONTINUITY_INVALID'});
export async function prepareSessionReturn({ stateRoot, unit, request, store, adapters, mode }) {
  const record = await store.read(unit);
  const review = mode === 'review';
  if (!record?.continuity?.goalId || (review ? record.kind !== 'review' || record.state !== 'Closed' : record.state !== 'Stopped')) throw invalid('unit is not ready to return its session');
  if (record.sessionFinalization) return {code:3,state:record.state,finalizePending:true,summary:'Existing session finalization is pending'};
  const goal = await createContinuityStore(stateRoot).read(record.continuity.goalId);
  if (review ? goal?.goal.status !== 'active' || goal.goal.remaining[0] !== record.targetUnit : goal?.goal.status !== 'blocked' || goal.goal.blocker?.unit !== unit) throw invalid('goal is not in the required state');
  if (!review && !record.failures?.some(item => item.path === goal.goal.blocker.evidence)) throw invalid('blocker does not reference a recorded unit failure');
  const source = await readFile(goal.source.path);
  if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== goal.source.digest) throw invalid('goal source changed');
  const entries = await createLedgerStore(stateRoot).withLock(unit, ledger => ledger.read());
  const completed = new Set(entries.filter(row=>row.event === 'result').map(row=>row.seq));
  if (entries.some(row=>row.event === 'intent' && !completed.has(row.seq) && !sessionEffectRetired(entries,row))) throw Object.assign(new Error('unresolved effects must be reconciled before session return'),{code:'EFFECT_UNCERTAIN'});
  const ownerRef = request.parentRuntime, recipientRef = request.returnTo;
  const custody = review ? goal.reviews?.findLast(item=>item.unit === unit)
    : goalOwner(goal, unit);
  if (!custody || !ownerRef || custody.sessionId !== ownerRef.sessionId || custody.incarnationId !== ownerRef.incarnationId || custody.cwd !== ownerRef.cwd || (review && !recipientRef) || recipientRef?.sessionId === ownerRef.sessionId) throw invalid('exact owner and any distinct recipient are required');
  if (custody.ownership === 'existing') assertAdoptedOwner(custody,await adapters.session.observe({cwd:ownerRef.cwd,targetCwd:ownerRef.cwd}));
  const requestDigest = effectArgsDigest(request);
  if (!review && !recipientRef && record.stopReport?.goalRevision === goal.revision) {
    if (record.stopReport.requestDigest !== requestDigest) throw invalid('stopped session report differs from the recorded request');
    return {code:0,state:record.state,resultPath:record.stopReport.resultPath,blocker:goal.goal.blocker,summary:'Stopped goal context recorded for the user'};
  }
  if (review) {
    const target = goalOwner(goal, record.targetUnit);
    if (!target || target.sessionId !== recipientRef.sessionId || target.incarnationId !== recipientRef.incarnationId || target.cwd !== recipientRef.cwd) throw invalid('review must return to the target owner');
  }
  let owner, recipient;
  if (recipientRef) {
    owner = await adapters.session.observe({cwd:ownerRef.cwd,targetCwd:recipientRef.cwd});
    assertAdoptedOwner(custody,owner);
    if (custody.nativeThreadId && owner.worker?.threadId !== custody.nativeThreadId) throw invalid('review native thread changed');
    if (owner.sessionId !== ownerRef.sessionId || owner.incarnationId !== ownerRef.incarnationId || (custody.ownership !== 'existing' && owner.closable !== true) || !owner.worker?.incarnationId) throw invalid('owner is not an authorized closable worker');
    recipient = await adapters.session.observe({recipient:recipientRef,nativeOwner:review && goalOwner(goal,record.targetUnit)?.ownership === 'existing'});
    if (review) assertAdoptedOwner(goalOwner(goal,record.targetUnit), recipient);
    if (recipient.sessionId !== recipientRef.sessionId || recipient.incarnationId !== recipientRef.incarnationId || recipient.cwd !== recipientRef.cwd) throw invalid('recipient identity changed');
  }
  validateHandoffPacket(request.handoffContent);
  const handoff = await snapshotText(stateRoot, goal.goal.id, `${request.handoffContent.replace(/\r\n/g,'\n').replace(/\n*$/,'\n')}`, 'md');
  const goalSnapshot = await snapshotGoal(stateRoot, goal);
  const fields = {...request.resultFields, remainingRisk:`${request.resultFields.remainingRisk} Handoff: ${handoff.path} ${handoff.digest}`,
    nextFirstAction:`${request.resultFields.nextFirstAction} Goal: ${goalSnapshot.path} ${goalSnapshot.digest}`};
  const outcome = review ? {kind:'next',path:handoff.path,unit:record.targetUnit}
    : {kind:'stopped',classification:request.classification,resumeCondition:goal.goal.blocker.resumeCondition};
  const resultContent = formatUnitResult({...fields,outcome});
  const result = await snapshotText(stateRoot, goal.goal.id, `${resultContent}\n`, 'md');
  if (!recipientRef) {
    await store.update(unit, current => {
      if (current.state !== record.state || current.revision !== record.revision || current.sessionFinalization) throw invalid('unit changed before stop report was recorded');
      return {...current,...(current.stopReport ? {stopReports:[...(current.stopReports ?? []),current.stopReport]} : {}),stopReport:{goalRevision:goal.revision,requestDigest,owner:ownerRef,resultPath:result.path,resultDigest:result.digest,handoffPath:handoff.path,handoffDigest:handoff.digest,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest}};
    });
    return {code:0,state:record.state,resultPath:result.path,blocker:goal.goal.blocker,summary:'Stopped goal context recorded for the user'};
  }
  await store.update(unit, current => {
    if (current.state !== record.state || current.revision !== record.revision || current.sessionFinalization) throw invalid('unit changed before finalization was recorded');
    return {...current,sessionFinalization:{mode,owner,recipient,...(custody.ownership === 'existing' ? {retainedOwner:custody} : {}),...(review && goalOwner(goal,record.targetUnit)?.ownership === 'existing' ? {recipientCustody:goalOwner(goal,record.targetUnit)} : {}),resultPath:result.path,resultDigest:result.digest,handoffPath:handoff.path,handoffDigest:handoff.digest,goalPath:goalSnapshot.path,goalDigest:goalSnapshot.digest}};
  });
  return {code:3,state:record.state,finalizePending:true,resultPath:result.path,summary:'Handoff recorded; result receipt and exact owner closure are pending'};
}
