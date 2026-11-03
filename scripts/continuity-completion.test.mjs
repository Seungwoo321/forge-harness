import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGoalCompletion} from './lib/continuity-completion.mjs';

const continuity = {goal:{id:'g1',status:'active',remaining:['u2'],criteria:['first','second']},transfers:[{unit:'u1',successor:'u2'}]};
const accepted = (state, id) => ({state,continuity:{goalId:'g1'},accepted:{head:'a'},acceptance:[{id,text:id === 'A1' ? 'first' : 'second'}],evidence:[{gate:'tests',exit:0,status:'passed',covers:[id]}]});
const proof = [{criterion:'first',unit:'u1',acceptance:'A1'},{criterion:'second',unit:'u2',acceptance:'A2'}];

test('goal completion requires all remaining work and passing evidence for each criterion',async () => {
  const units = new Map([['u1',accepted('Closed','A1')],['u2',accepted('Accepted','A2')]]);
  const unitStore = {read:async id=>units.get(id)};
  assert.equal(await validateGoalCompletion({continuity,unit:'u2',proof,unitStore}),true);
  await assert.rejects(validateGoalCompletion({continuity:{...continuity,goal:{...continuity.goal,remaining:['u2','u3']}},unit:'u2',proof,unitStore}),{code:'GOAL_INCOMPLETE'});
  await assert.rejects(validateGoalCompletion({continuity,unit:'u2',proof:proof.slice(0,1),unitStore}),{code:'GOAL_INCOMPLETE'});
  units.set('u1',accepted('Implementing','A1'));
  await assert.rejects(validateGoalCompletion({continuity,unit:'u2',proof,unitStore}),{code:'GOAL_INCOMPLETE'});
  units.set('u1',accepted('Closed','A1')); units.get('u2').evidence[0].status='pending';
  await assert.rejects(validateGoalCompletion({continuity,unit:'u2',proof,unitStore}),{code:'GOAL_INCOMPLETE'});
});
