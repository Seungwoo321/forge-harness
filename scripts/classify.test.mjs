import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, createCauseKey, decideFailure, finishResolver, reserveRetry, resumeFailure, transitionForFailure } from './lib/classify.mjs';

const unit = (state, extra = {}) => ({ schema: 'harness.unit/1', unit: 'U-1', revision: 1, kind: 'impl', state, blockedFrom: null, stoppedFrom: null, ...extra });

test('cause keys normalize location and reason while excluding task identity', () => {
  const first = createCauseKey({ failurePoint: 'src\\file.mjs:12', reason: '  TypeError   x ', taskId: 'TASK-A' });
  const second = createCauseKey({ failurePoint: 'src/file.mjs:12', reason: 'TypeError x', taskId: 'TASK-B' });
  assert.equal(first, 'src/file.mjs:12|TypeError x');
  assert.equal(second, first);
});

test('confirmed class and stable signature survive later classification changes', () => {
  assert.equal(classifyFailure({ class: 'environment' }, 'product'), 'product');
  const result = decideFailure({ failure: { class: 'product', failurePoint: 'x:2', reason: 'bad' } });
  assert.equal(result.signature, 'product|x:2|bad');
  assert.equal(result.action, 'retry');
});

test('retry budget excludes the original failure and diagnoses recurrence before final retry', () => {
  const first = decideFailure({ failure: { class: 'product', failurePoint: 'x:2', reason: 'bad' }, retryLimit: 2 });
  assert.equal(first.cause.occurrences, 1);
  assert.equal(first.cause.retries, 1);
  assert.equal(first.action, 'retry');
  const repeated = decideFailure({ failure: { class: 'product', failurePoint: 'x:2', reason: 'bad' }, cause: first.cause, retryLimit: 2 });
  assert.equal(repeated.action, 'diagnose');
  const afterDiagnosis = reserveRetry(repeated.cause, 2);
  assert.equal(afterDiagnosis.cause.retries, 2);
  const exhausted = decideFailure({ failure: { class: 'product', failurePoint: 'x:2', reason: 'bad' }, cause: afterDiagnosis.cause, retryLimit: 2 });
  assert.equal(exhausted.action, 'stop');
});

test('limit one stops at second failure without resolver or retry', () => {
  const first = decideFailure({ failure: { class: 'product', failurePoint: 'x', reason: 'bad' }, retryLimit: 1 });
  const second = decideFailure({ failure: { class: 'product', failurePoint: 'x', reason: 'bad' }, cause: first.cause, retryLimit: 1 });
  assert.equal(first.action, 'retry');
  assert.equal(second.action, 'stop');
});

test('needs-diagnosis does not consume the retry allowance', () => {
  const result = decideFailure({ failure: { class: 'product', failurePoint: 'x', reason: 'bad' }, needsDiagnosis: true });
  assert.equal(result.action, 'diagnose');
  assert.equal(result.cause.retries, 0);
  assert.equal(reserveRetry(result.cause, 2).cause.retries, 1);
});

test('harness resolver reservations enforce depth, uniqueness, and cap', () => {
  const failure = { class: 'harness', failurePoint: 'runner', reason: 'crash' };
  const first = decideFailure({ failure, resolverLimit: 2 });
  assert.equal(first.action, 'resolver');
  assert.equal(first.cause.activeResolver, true);
  assert.equal(decideFailure({ failure, cause: first.cause, resolverLimit: 2 }).action, 'stop');
  assert.equal(decideFailure({ failure, resolverLimit: 2, resolverDepth: 1 }).action, 'stop');
  const finished = finishResolver(first.cause);
  const second = decideFailure({ failure, cause: finished, resolverLimit: 2 });
  assert.equal(second.action, 'resolver');
  assert.equal(second.cause.resolverAttempts, 2);
  assert.equal(decideFailure({ failure, cause: finishResolver(second.cause), resolverLimit: 2 }).action, 'stop');
});

test('environment and user-domain failures do not use product retry budget', () => {
  const environment = decideFailure({ failure: { class: 'environment', failurePoint: 'network', reason: 'offline' } });
  const user = decideFailure({ failure: { class: 'user-domain', failurePoint: 'policy', reason: 'approval' } });
  assert.equal(environment.action, 'resume');
  assert.equal(environment.cause.retries, 0);
  assert.equal(user.action, 'defer');
  assert.equal(user.cause.retries, 0);
});

test('blocked and stopped recovery resumes at the exact recorded state', () => {
  const blocked = transitionForFailure(unit('SelfGated'), { action: 'resolver' });
  assert.equal(blocked.state, 'Blocked');
  assert.equal(resumeFailure(blocked).state, 'SelfGated');
  const stopped = transitionForFailure(unit('Delivered'), { action: 'stop' });
  assert.equal(stopped.state, 'Stopped');
  assert.equal(resumeFailure(stopped).state, 'Delivered');
});

test('missing cause details and out-of-range budgets are rejected', () => {
  assert.throws(() => createCauseKey({ failurePoint: 'x' }), /reason is required/);
  assert.throws(() => decideFailure({ failure: { failurePoint: 'x', reason: 'bad' }, retryLimit: 6 }), /retryLimit/);
});
