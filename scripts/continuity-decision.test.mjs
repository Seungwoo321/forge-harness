import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideContinuity, composeGoalPrompt } from './lib/continuity-decision.mjs';

const goal = { id:'goal-1', objective:'Complete the product', criteria:['deliver both units'], remaining:['unit-1','unit-2'], status:'active' };
const policy = {runtime:'cmux',provider:'codex',account:'/account/personal',model:'example-model',effort:'high',argv:['codex']};

test('unit completion cannot claim an unfinished goal or skip its successor', () => {
  assert.throws(() => decideContinuity({goal,unit:'unit-1',goalComplete:true}), {code:'CONTINUITY_INVALID'});
  assert.throws(() => decideContinuity({goal,unit:'unit-1'}), {code:'CONTINUITY_INVALID'});
  assert.deepEqual(decideContinuity({goal,unit:'unit-1',successor:{approved:true,unit:'unit-2'}}), {kind:'next',unit:'unit-2'});
});

test('blockers preserve the resume condition and prompts bind policy and handoff', () => {
  assert.deepEqual(decideContinuity({goal:{...goal,status:'blocked',blocker:{unit:'unit-1',reason:'access',resumeCondition:'permission',evidence:'run:1'}},unit:'unit-1'}), {kind:'blocked',blocker:{unit:'unit-1',reason:'access',resumeCondition:'permission',evidence:'run:1'}});
  for (const runtime of ['cmux','orca']) {
    const prompt = composeGoalPrompt({goal,policy:{...policy,runtime},handoff:{path:'/work/handoff.md',digest:`sha256:${'a'.repeat(64)}`}});
    assert.match(prompt,/Complete the product/); assert.match(prompt,new RegExp(runtime)); assert.match(prompt,/handoff\.md/);
  }
});

test('invalid account or contradictory model options fail before launching', () => {
  const handoff={path:'/work/handoff.md',digest:`sha256:${'a'.repeat(64)}`};
  assert.throws(()=>composeGoalPrompt({goal,policy:{...policy,account:'relative'},handoff}),{code:'CONTINUITY_INVALID'});
  assert.throws(()=>composeGoalPrompt({goal,policy:{...policy,argv:['codex','--model','other']},handoff}),{code:'CONTINUITY_INVALID'});
});
