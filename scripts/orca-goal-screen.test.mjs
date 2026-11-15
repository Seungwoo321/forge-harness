import test from 'node:test';
import assert from 'node:assert/strict';
import {orcaGoalScreen} from './lib/orca-goal-screen.mjs';
const view={source:'screen',handle:'receiver',truncated:false,limited:false,tail:['>_ OpenAI Codex (v0.169.0)','› Ask Codex to do anything','· Ready ·'],returnedLineCount:3};
test('fresh native Orca reads require the exact receiver and a complete rendered response',()=>{
  assert.equal(orcaGoalScreen(view,'receiver',true).screen,view.tail.join('\n'));
  assert.equal(orcaGoalScreen({...view,truncated:true},'receiver',true).screen,view.tail.join('\n'));
  for(const patch of [{source:'stream'},{handle:'foreign'},{limited:true},{returnedLineCount:2},{tail:'text'},{tail:['text',null]},{truncated:undefined},{limited:undefined}])
    assert.throws(()=>orcaGoalScreen({...view,...patch},'receiver',true));
});
