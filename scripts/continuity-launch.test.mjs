import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedLaunch } from './lib/continuity-launch.mjs';
const goal = {id:'g1',objective:'finish',criteria:['tested'],remaining:['u1'],status:'active'};
const handoff = {path:'/work/handoff.md',digest:`sha256:${'a'.repeat(64)}`};

test('account and model selection are passed as explicit process data for both providers and runtimes', () => {
  for (const runtime of ['cmux','orca']) for (const provider of ['codex','claude']) {
    const policy = {runtime,provider,account:'/accounts/work',model:'model',effort:'high',argv:[provider]};
    const result = buildManagedLaunch({goal,policy,handoff,goalRef:{path:'/work/goal.json',digest:`sha256:${'b'.repeat(64)}`},effectKey:`sha256:${'c'.repeat(64)}`});
    assert.deepEqual(result.env,provider === 'codex' ? {CODEX_HOME:'/accounts/work'} : {CLAUDE_CONFIG_DIR:'/accounts/work'});
    assert.ok(result.argv.includes('--model')); assert.ok(result.argv.includes('model'));
    assert.match(result.goalPrompt,/handoff\.md/);
    assert.ok(!result.argv.includes(result.goalPrompt));
  }
});

test('role policy chooses the reviewer model without changing implementation defaults', () => {
  const policy={runtime:'cmux',provider:'codex',account:'/account',model:'implementation',effort:'high',argv:['codex'],roles:{review:{model:'reviewer',effort:'xhigh'}}};
  const ref={path:'/work/goal.json',digest:`sha256:${'b'.repeat(64)}`};
  const result=buildManagedLaunch({goal,policy,handoff,goalRef:ref,effectKey:`sha256:${'c'.repeat(64)}`,role:'review'});
  assert.ok(result.argv.includes('reviewer'));assert.ok(!result.argv.includes('implementation'));assert.ok(result.argv.includes('model_reasoning_effort="xhigh"'));
});

test('managed launches bind their stop hook to the exact goal state root and unit', () => {
  const policy={runtime:'cmux',provider:'codex',account:'/account',model:'m',effort:'high',argv:['codex']};
  const result=buildManagedLaunch({goal,policy,handoff,unit:'u1',goalRef:{path:'/state/goals/g1/snapshots/goal.json',digest:`sha256:${'b'.repeat(64)}`},effectKey:`sha256:${'c'.repeat(64)}`});
  assert.equal(result.env.FORGE_CONTINUITY_ROOT,'/state');
  assert.equal(result.env.FORGE_CONTINUITY_GOAL,'g1');
  assert.equal(result.env.FORGE_CONTINUITY_UNIT,'u1');
  assert.throws(()=>buildManagedLaunch({goal,policy,handoff,unit:'u1',goalRef:{path:'/state/other/goal.json',digest:`sha256:${'b'.repeat(64)}`}}),{code:'CONTINUITY_INVALID'});
});

test('native goal references immutable packets without embedding their contents', () => {
  const policy={runtime:'orca',provider:'claude',account:'/account',model:'m',effort:'high',argv:['claude']};
  const ref={path:'/work/goal.json',digest:`sha256:${'b'.repeat(64)}`};
  const result=buildManagedLaunch({goal,policy,handoff,goalRef:ref,effectKey:`sha256:${'c'.repeat(64)}`,
    packets:[{path:'/work/handoff.md',digest:handoff.digest,content:'private packet body'}]});
  assert.match(result.goalPrompt,/\/work\/handoff\.md/);
  assert.ok(!result.goalPrompt.includes('private packet body'));
  assert.ok(!/[\r\n]/.test(result.goalPrompt));
  const spaced=buildManagedLaunch({goal:{...goal,objective:'keep  both spaces'},policy,handoff,goalRef:ref,effectKey:`sha256:${'c'.repeat(64)}`});
  assert.ok(spaced.goalPrompt.includes('keep  both spaces'));
  assert.throws(()=>buildManagedLaunch({goal:{...goal,objective:'x'.repeat(4001)},policy,handoff,goalRef:ref,effectKey:`sha256:${'c'.repeat(64)}`}),{code:'CONTINUITY_INVALID'});
});

test('launch paths resolve from the verified worker directory without repeated absolute prefixes',()=>{
 const policy={runtime:'cmux',provider:'codex',account:'/account',model:'m',effort:'low',argv:['codex']};
 const result=buildManagedLaunch({goal,policy,handoff,cwd:'/work',goalRef:{path:'/work/goal.json',digest:`sha256:${'b'.repeat(64)}`}});
 assert.ok(result.goalPrompt.includes(`Read handoff.md (${handoff.digest})`));
 assert.ok(result.goalPrompt.includes('Read goal.json (sha256:'));
 assert.ok(!result.goalPrompt.includes('/work/'));
});
