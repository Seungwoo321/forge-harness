import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockGoal, resumeGoal } from './lib/continuity-transitions.mjs';

test('block and resume preserve evidence and reject stale or incomplete decisions', () => {
  const original = {revision:1,goal:{status:'active',remaining:['u1']}};
  assert.throws(() => blockGoal(original,{expectedRevision:1,unit:'u1',reason:'denied'}), {code:'CONTINUITY_INVALID'});
  const blocked = blockGoal(original,{expectedRevision:1,unit:'u1',reason:'denied',resumeCondition:'access granted',evidence:'run:1'});
  assert.throws(() => resumeGoal(blocked,{expectedRevision:1,unit:'u1',resolutionEvidence:'run:2'}), {code:'CONTINUITY_STALE'});
  const resumed = resumeGoal(blocked,{expectedRevision:2,unit:'u1',resolutionEvidence:'run:2'});
  assert.equal(resumed.goal.status,'active');
  assert.deepEqual(resumed.goal.remaining,['u1']);
  assert.deepEqual(resumed.blockerHistory,[{unit:'u1',reason:'denied',resumeCondition:'access granted',evidence:'run:1',resolutionEvidence:'run:2'}]);
});

test('adding approved work preserves ordering and cannot recycle a completed unit', async () => {
  const {appendGoalWork}=await import('./lib/continuity-transitions.mjs');
  const current={revision:2,goal:{status:'active',remaining:['u2']},transfers:[{unit:'u1',successor:'u2'}]};
  const next=appendGoalWork(current,{expectedRevision:2,units:['u3'],evidence:'plan:approved'});
  assert.deepEqual(next.goal.remaining,['u2','u3']);
  assert.throws(()=>appendGoalWork(current,{expectedRevision:2,units:['u1'],evidence:'plan:approved'}),{code:'CONTINUITY_INVALID'});
});
