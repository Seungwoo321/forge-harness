import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDelivery, bindDeliveryCommit, bindMergeResult, validateAcceptedContent } from './lib/delivery.mjs';

const accepted = { head: 'head-1', validatedHead: 'head-1', contentFingerprint: 'fp-1', basis: 'gates' };
const current = { head: 'head-1', contentFingerprint: 'fp-1' };

test('delivery level never exceeds policy', () => {
  assert.deepEqual(authorizeDelivery({ delivery: 'push' }, 'push'), { level: 'push' });
  assert.throws(() => authorizeDelivery({ delivery: 'push' }, 'pr'), { code: 'DELIVERY_DENIED' });
});

test('head or content changes require SelfGated reacceptance', () => {
  assert.deepEqual(validateAcceptedContent(accepted, { head: 'head-1', contentFingerprint: 'fp-2' }), {
    valid: false, nextState: 'SelfGated', reason: 'accepted content fingerprint changed',
  });
  assert.equal(validateAcceptedContent(accepted, { head: 'head-2', contentFingerprint: 'fp-1' }).nextState, 'SelfGated');
});

test('same-tree delivery commit updates accepted head while preserving validated head', () => {
  const result = bindDeliveryCommit(accepted, current, {
    sha: 'commit-1', tree: 'tree-1', parent: 'head-1', contentFingerprint: 'fp-1',
  });
  assert.deepEqual(result.accepted, { ...accepted, head: 'commit-1' });
  assert.equal(result.binding.beforeHead, 'head-1');
  assert.equal(result.binding.tree, 'tree-1');
  assert.deepEqual(bindDeliveryCommit(accepted, current, {
    sha: 'commit-2', tree: 'tree-2', parent: 'head-1', contentFingerprint: 'fp-2',
  }), { valid: false, nextState: 'SelfGated', reason: 'delivery commit content differs from accepted content' });
});

test('merge target head is recorded separately from accepted unit head', () => {
  const result = bindMergeResult(accepted, current, { acceptedHead: 'head-1', mergeHead: 'target-9' });
  assert.equal(result.accepted.head, 'head-1');
  assert.equal(result.deliveryResult.head, 'head-1');
  assert.equal(result.deliveryResult.mergeHead, 'target-9');
  assert.throws(() => bindMergeResult(accepted, current, { acceptedHead: 'other', mergeHead: 'target-9' }), {
    code: 'DELIVERY_HEAD_MISMATCH',
  });
});
