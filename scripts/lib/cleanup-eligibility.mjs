import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { effectArgsDigest } from './approvals.mjs';
import { createContinuityStore } from './continuity-store.mjs';
import { createLedgerStore, unresolvedEffect } from './ledger.mjs';

const refuse = message => { throw Object.assign(new Error(message), { code: 'CLEANUP_INELIGIBLE' }); };
const invalid = message => { throw Object.assign(new Error(message), { code: 'CLEANUP_REQUEST_INVALID' }); };
const keys = ['unit', 'expectedRevision', 'expectedGoalRevision', 'repo', 'branch', 'worktree'];
const closed = (rows, owner) => rows.some(row => row.event === 'result' && row.result?.closed === true
  && row.result.sessionId === owner?.sessionId && row.result.incarnationId === owner?.incarnationId
  && rows.some(intent => intent.event === 'intent' && intent.effect === 'session.close' && intent.seq === row.seq && intent.key === row.key));
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };

// Read-only. The host deletes; it re-runs this check immediately before each destructive step and requires an unchanged digest.
export async function checkCleanupEligibility({ stateRoot, store, unit, request }) {
  if (!request || Object.keys(request).sort().join(',') !== [...keys].sort().join(',') || request.unit !== unit
    || ![request.expectedRevision, request.expectedGoalRevision].every(n => Number.isSafeInteger(n) && n > 0)
    || !['repo', 'branch'].every(key => typeof request[key] === 'string' && request[key])
    || typeof request.worktree !== 'string' || !path.isAbsolute(request.worktree)) invalid('exact cleanup request with an absolute worktree is required');
  const worktree = await realpath(request.worktree).catch(() => invalid('worktree is unavailable'));
  if (inside(await realpath(stateRoot), worktree)) refuse('lifecycle evidence lives inside the deletion target');
  const ledgers = createLedgerStore(stateRoot), goals = createContinuityStore(stateRoot);
  const goalId = (await store.read(unit))?.continuity?.goalId;
  if (!goalId) refuse('unmanaged work requires an explicit host cleanup policy');
  // Review units are read under their own locks first; the unit section then requires the same goal bytes.
  const observedGoal = await goals.read(goalId), reviews = [];
  for (const review of observedGoal?.reviews ?? []) {
    const reviewRows = await ledgers.withLock(review.unit, reviewLedger => reviewLedger.read());
    const reviewRecord = await store.read(review.unit);
    if (reviewRecord?.state !== 'Closed' || !reviewRecord.sessionFinalization?.closeReceipt || unresolvedEffect(reviewRows)) refuse(`review ${review.unit} is not closed`);
    reviews.push({ unit: review.unit, recordDigest: effectArgsDigest(reviewRecord), ledgerDigest: effectArgsDigest(reviewRows) });
  }
  return ledgers.withLock(unit, async ledger => store.withLock(unit, async record => {
    if (record.continuity?.goalId !== goalId) refuse('goal binding changed');
    if (['review', 'ops'].includes(record.kind) || record.state !== 'Closed') refuse('a Closed change unit is required');
    if (record.revision !== request.expectedRevision) refuse('unit revision changed');
    const goal = await goals.read(record.continuity.goalId);
    if (!goal || goal.revision !== request.expectedGoalRevision || effectArgsDigest(goal) !== effectArgsDigest(observedGoal)) refuse('goal revision changed');
    if (goal.goal.status !== 'complete' || goal.goal.remaining.length || goal.completion?.unit !== unit) refuse('the completed goal final unit is required');
    if (record.accepted?.repo !== request.repo || record.accepted.branch !== request.branch) refuse('repository or branch differs from the accepted target');
    const plan = record.sessionFinalization;
    if (!plan?.owner || plan.ownerRetained === true) refuse('the final owner is retained or its closure is unrecorded');
    if (await realpath(plan.owner.cwd).catch(() => null) !== worktree) refuse('worktree differs from the final owner cwd');
    const rows = await ledger.read();
    if (unresolvedEffect(rows)) refuse('unit has unresolved effects');
    if (!closed(rows, plan.owner)) refuse('exact final owner closure is unproven');
    const binding = { request, worktree, unitDigest: effectArgsDigest(record), goalDigest: effectArgsDigest(goal), ledgerDigest: effectArgsDigest(rows), reviews };
    return { eligible: true, unit, goalId: goal.goal.id, worktree, repo: request.repo, branch: request.branch, eligibilityDigest: effectArgsDigest(binding) };
  }));
}
