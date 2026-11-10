import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGoalCompletion} from './lib/continuity-completion.mjs';
import {commitGoalContinuation} from './lib/continuity-finish.mjs';
import {effectArgsDigest} from './lib/approvals.mjs';

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

test('goal evidence retains an exact Delivered predecessor only with its recorded continuation',async()=>{
  const prior=accepted('Delivered','A1'),units=new Map([['u1',prior],['u2',accepted('Accepted','A2')]]),unitStore={read:async id=>units.get(id)};
  const goal={...continuity,transfers:[{unit:'u1',successor:'u2',deliveredContinuation:true,unitDigest:effectArgsDigest(prior)}]};
  assert.equal(await validateGoalCompletion({continuity:goal,unit:'u2',proof,unitStore}),true);
  units.set('u1',{...prior,accepted:{head:'changed'}});
  await assert.rejects(validateGoalCompletion({continuity:goal,unit:'u2',proof,unitStore}),{code:'GOAL_INCOMPLETE'});
  units.set('u1',prior);
  await assert.rejects(validateGoalCompletion({continuity,unit:'u2',proof,unitStore}),{code:'GOAL_INCOMPLETE'});
});

test('same-session completion advances the goal once while retaining its exact owner', async () => {
  const owner={sessionId:'owner',incarnationId:'inc',cwd:'/work'};
  let goal={revision:2,goal:{id:'g1',status:'active',remaining:['u1','u2']},bootstraps:[{unit:'u1',...owner}]};
  let unit={state:'Closed',goalContinuation:{goalId:'g1',revision:2,nextUnit:'u2',owner}};
  const continuityStore={transaction:async(_id,change)=>goal=change(goal)},unitStore={read:async()=>unit};
  const args={continuityStore,unitStore,goalId:'g1',unit:'u1'};
  await commitGoalContinuation(args);
  assert.deepEqual(goal.goal.remaining,['u2']);assert.equal(goal.bootstraps.at(-1).sessionId,'owner');
  await commitGoalContinuation(args);assert.equal(goal.revision,3);assert.equal(goal.transfers.length,1);
  unit={...unit,goalContinuation:{...unit.goalContinuation,owner:{...owner,incarnationId:'other'}}};
  await assert.rejects(commitGoalContinuation(args),{code:'CONTINUITY_STALE'});
});

test('AC-2: stale completion cannot close its owner after goal work changes', async () => {
  const {fenceGoalClose} = await import('./lib/continuity-completion.mjs');
  const plan = {owner:{sessionId:'one'},resultDigest:'digest'};
  const completion = {goalId:'g1',revision:2,proof};
  const record = {...accepted('Delivered','A2'),sessionFinalization:plan,goalCompletion:completion};
  const units = new Map([['u1',accepted('Closed','A1')],['u2',record]]);
  const unitStore = {read:async id=>units.get(id),withLock:async(id,fn)=>fn(units.get(id))};
  let goal = {...continuity,revision:3}; let calls=0;
  const continuityStore = {transaction:async(_id,fn)=>fn(goal)};
  await assert.rejects(fenceGoalClose({continuityStore,unitStore,unit:'u2',plan,completion,action:async()=>calls++}),{code:'GOAL_INCOMPLETE'});
  assert.equal(calls,0);
  goal = {...continuity,revision:2};
  await fenceGoalClose({continuityStore,unitStore,unit:'u2',plan,completion,action:async()=>calls++});
  assert.equal(calls,1);
  units.set('u2',{...record,sessionFinalization:{...plan,resultDigest:'other'}});
  await assert.rejects(fenceGoalClose({continuityStore,unitStore,unit:'u2',plan,completion,action:async()=>calls++}),{code:'GOAL_INCOMPLETE'});
  assert.equal(calls,1);
});
