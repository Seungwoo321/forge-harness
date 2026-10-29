import { authorizeDelivery, bindDeliveryCommit, bindMergeResult, validateAcceptedContent } from './delivery.mjs';
import { createLedgerStore, executeEffect } from './ledger.mjs';
import { resolvePolicy, prepareEffect } from './policy.mjs';
import { transitionRecord } from './unit-state.mjs';
import { createRecoveryStore } from './recovery-store.mjs';
import { effectArgsDigest, resolveEffectApproval } from './approvals.mjs';
import { hasInvalidEvidence } from './evidence.mjs';

const deliveryEffects = new Set(['git.commit', 'git.push', 'git.integrate', 'pr.create', 'pr.merge']);
const metadata = ['repo', 'branch', 'tree', 'indexTree', 'headTree', 'base'];

function failure(code, message) { return Object.assign(new Error(message), { code }); }

export function acceptedDeliveryMetadata(target) {
  if (metadata.some(field => typeof target?.[field] !== 'string' || !target[field])) {
    throw failure('ADAPTER_INVALID', 'delivery inspection requires repo, branch, tree, indexTree, headTree, and base');
  }
  return Object.fromEntries(metadata.map(field => [field, target[field]]));
}

export function validateDeliveryContext(context) {
  const fields = ['resourceOwned', 'productOwned', 'inScope', 'operational', 'irreversible', 'containsSecret', 'forbiddenCommand'];
  if (!context || fields.some(field => typeof context[field] !== 'boolean')) {
    throw failure('ADAPTER_INVALID', 'delivery context must verify ownership, scope, environment, irreversibility, secrets, and command safety');
  }
  return { ...Object.fromEntries(fields.map(field => [field, context[field]])), explicitUserInstruction: context.explicitUserInstruction === true };
}

export async function executeDelivery({ stateRoot, store, unit, requestedDelivery, delivery = {}, adapters }) {
  const ledgerStore = createLedgerStore(stateRoot);
  let record = await store.read(unit);
  const { policy } = resolvePolicy({ unit: record.policyOverrides ?? {}, project: record.policy ?? {} }, { nonInteractive: true });
  authorizeDelivery(policy, requestedDelivery);
  if (!['Accepted', 'Delivering', 'Delivered'].includes(record.state)) throw failure('INVALID_TRANSITION', 'delivery requires an accepted unit');
  if (record.deliveryPlan && record.state !== 'Accepted' && record.deliveryPlan.level !== requestedDelivery) {
    throw failure('DELIVERY_PLAN_MISMATCH', 'resumed delivery must retain its original level');
  }
  const inspect = current => adapters.git.inspectUnit({ unit, record: current });
  const validAcceptance = current => current.accepted && !hasInvalidEvidence(current.evidence);
  const invalidate = async (target, reason) => {
    record = await store.update(unit, current => {
      const updated = { ...current,
      head: target?.head ?? current.head, contentFingerprint: target?.contentFingerprint ?? current.contentFingerprint,
      accepted: null, reviewDecision: null, reviewedHead: null, verdict: null, deliveryResult: null, terminalProjection: null,
      };
      return current.state === 'SelfGated' ? updated : transitionRecord(updated, 'SelfGated');
    });
    return { code: 1, state: record.state, summary: reason };
  };
  if (!validAcceptance(record)) return invalidate(null, 'Accepted gate evidence is invalid; reacceptance is required');
  if (requestedDelivery === 'none') {
    record = await store.update(unit, async current => {
      const target = await inspect(current);
      if (!validAcceptance(current) || !validateAcceptedContent(current.accepted, target).valid) return transitionRecord({ ...current, accepted: null, reviewDecision: null }, 'SelfGated');
      return current.state === 'Accepted' ? transitionRecord(current, 'Delivering') : current;
    });
    if (record.state === 'SelfGated') return { code: 1, state: record.state, summary: 'Accepted target changed and requires revalidation' };
    if (record.state === 'Delivering') record = await store.update(unit, async current => {
      if (!validAcceptance(current) || !validateAcceptedContent(current.accepted, await inspect(current)).valid) return transitionRecord({ ...current, accepted: null, reviewDecision: null }, 'SelfGated');
      return transitionRecord({ ...current, deliveryResult: { level: 'none', head: current.accepted.head, mergeHead: null, effectRefs: [] } }, 'Delivered');
    });
    return { code: record.state === 'SelfGated' ? 1 : 0, state: record.state, summary: 'Delivery complete' };
  }
  acceptedDeliveryMetadata(record.accepted);
  if (record.state === 'Delivered') {
    if (record.deliveryResult?.level !== requestedDelivery) throw failure('DELIVERY_PLAN_MISMATCH', 'completed delivery level cannot be changed');
    const target = await inspect(record);
    return validateAcceptedContent(record.accepted, target).valid
      ? { code: 0, state: record.state, summary: 'Delivery already complete' }
      : invalidate(target, 'Accepted target changed after delivery');
  }
  const plan = { level: requestedDelivery, repo: record.accepted.repo, branch: record.accepted.branch, base: record.accepted.base,
    message: delivery.message ?? `Complete ${unit}`, title: delivery.title ?? `Complete ${unit}`, body: delivery.body ?? '' };
  for (const field of ['repo', 'branch', 'base']) {
    if (delivery[field] !== undefined && delivery[field] !== plan[field]) throw failure('DELIVERY_PLAN_MISMATCH', `delivery ${field} differs from acceptance`);
  }
  if (record.state !== 'Accepted' && record.deliveryPlan && effectArgsDigest(plan) !== effectArgsDigest(record.deliveryPlan)) {
    throw failure('DELIVERY_PLAN_MISMATCH', 'resumed delivery must retain its original target and presentation');
  }
  if (record.state === 'Accepted') record = await store.update(unit, current => transitionRecord({ ...current, deliveryPlan: plan, deliveryResult: null }, 'Delivering'));

  const refs = [];
  const reconciled = new Map();
  const stale = async () => {
    record = await store.read(unit);
    const target = await inspect(record);
    if (!validAcceptance(record) || !validateAcceptedContent(record.accepted, target).valid
      || ['repo', 'branch', 'tree', 'base'].some(field => target[field] !== record.accepted[field])) return target;
    return null;
  };
  const run = async (effect, args) => {
    if (!deliveryEffects.has(effect)) throw failure('EFFECT_UNREGISTERED', 'unregistered delivery operation');
    const recovered = reconciled.get(prepareEffect(effect, args).key);
    if (recovered) return recovered;
    const provider = effect.startsWith('pr.') ? adapters.repository : adapters.git;
    if (!provider || ['deliveryContext', 'execute', 'verify'].some(name => typeof provider[name] !== 'function')) throw failure('ADAPTER_MISSING', `${effect} requires a registered execution and verification provider`);
    const context = validateDeliveryContext(await provider.deliveryContext({ unit, record, effect, args }));
    const validateResult = result => {
      if (['not-applied', 'remote-ahead', 'conflict'].includes(result?.status)) {
        if (!result.verify || typeof result.verify.adapter !== 'string' || typeof result.verify.operation !== 'string'
          || !result.verify.args || typeof result.verify.args !== 'object' || Array.isArray(result.verify.args)) throw failure('ADAPTER_INVALID', 'terminal delivery failure requires structured verification');
        if (result.status === 'remote-ahead' && (effect !== 'git.push' || typeof result.remoteHead !== 'string' || !result.remoteHead)) throw failure('ADAPTER_INVALID', 'remote-ahead result requires a push and remote head');
        if (result.status === 'conflict' && (effect !== 'git.integrate' || !result.observed
          || ['head', 'tree', 'indexTree'].some(field => typeof result.observed[field] !== 'string')
          || !Array.isArray(result.observed.conflictPaths))) throw failure('ADAPTER_INVALID', 'integration conflict requires observed target and conflict paths');
        if (result.status !== 'remote-ahead' && (!result.failure || !['product', 'harness', 'environment', 'user-domain', 'unknown'].includes(result.failure.class)
          || typeof result.failure.reason !== 'string' || !result.failure.reason)) throw failure('ADAPTER_INVALID', 'terminal failure requires a classification and reason');
        return result;
      }
      const required = ({ 'git.commit': ['sha', 'parent', 'tree', 'contentFingerprint'], 'git.push': ['head'],
        'git.integrate': ['head'], 'pr.create': ['pr', 'repo', 'branch', 'head', 'base'], 'pr.merge': ['acceptedHead', 'base', 'mergeHead'] })[effect];
      if (!result || required.some(field => result[field] === undefined || result[field] === null || result[field] === '')
        || effect === 'git.commit' && result.parent !== args.parent
        || effect === 'git.push' && result.head !== args.head
        || effect === 'pr.create' && (result.status !== 'open' || ['repo', 'branch', 'head', 'base'].some(field => result[field] !== args[field]))
        || effect === 'pr.merge' && (result.acceptedHead !== args.head || result.base !== args.base)) throw failure('ADAPTER_INVALID', 'delivery result does not bind the requested target');
      return result;
    };
    let approvalRef = delivery.approvalRef ?? null;
    if (context.irreversible) {
      const approval = await resolveEffectApproval({ record, effect, args, approvalRef, provider: adapters.provider });
      approvalRef = approval.id;
    }
    const output = await executeEffect({ unit, effect, args, policy, context, approvalRef,
      store: context.irreversible ? { withLock: (id, action) => ledgerStore.withLock(id, ledger => store.withLock(id, async current => {
        record = current;
        if (current.state !== 'Delivering' || await stale()) throw failure('EFFECT_APPROVAL_REQUIRED', 'delivery acceptance changed before execution');
        await resolveEffectApproval({ record: current, effect, args, approvalRef, provider: adapters.provider });
        return await action(ledger);
      })) } : ledgerStore,
      retryResolved: async ({ intent }) => {
        const recovery = createRecoveryStore(stateRoot);
        const latest = record.failures?.at(-1);
        if (!latest?.path) return false;
        const id = latest.path.split('/').at(-1).replace(/\.json$/, '');
        const failed = await recovery.readFailure(unit, id);
        const cause = (await recovery.causes())[failed.causeKey];
        return failed.evidence?.seq === intent.seq && failed.evidence?.key === intent.key
          && (cause?.lastAction === 'retry' || cause?.lastAction === 'resume'
            || cause?.lastAction === 'resolver-completed' && cause.activeResolver === false);
      },
      adapter: { now: () => adapters.now(), execute: async input => {
        const changed = await stale();
        if (changed) return { status: 'not-applied', failure: { class: 'product', reason: 'accepted target changed before execution' },
          verify: { adapter: 'git', operation: 'unit.inspect', args: { unit }, observed: changed } };
        if (effect === 'pr.create') {
          const existing = await provider.verify(input);
          if (existing?.status === 'open' && ['repo', 'branch', 'head', 'base'].every(field => existing[field] === args[field])) return validateResult(existing.result);
          if (!['not-found', 'closed', 'merged'].includes(existing?.status)) throw failure('EFFECT_UNCERTAIN', 'existing PR state is not resolved');
        }
        return validateResult(await provider.execute(input));
      }, verify: async input => {
        const verified = await provider.verify(input);
        if (!verified?.verify || typeof verified.verify.adapter !== 'string' || typeof verified.verify.operation !== 'string'
          || !verified.verify.args || typeof verified.verify.args !== 'object' || Array.isArray(verified.verify.args)) return { status: 'unknown' };
        if (verified?.status === 'completed' || verified?.status === 'open') {
          try { validateResult(verified.result); } catch { return { status: 'unknown' }; }
        }
        return verified;
      } },
    });
    if (output.result?.status === 'not-applied') {
      const changed = await stale();
      if (changed) return { stop: await invalidate(changed, 'Accepted target changed; reacceptance is required') };
    }
    if (output.status === 'uncertain') {
      if (effect === 'git.commit') {
        const target = await inspect(record);
        if (target.contentFingerprint !== record.accepted.contentFingerprint || target.tree !== record.accepted.tree
          || target.indexTree !== record.accepted.tree) return { stop: await invalidate(target, 'Commit changed accepted content; reacceptance is required') };
      }
      return { stop: { code: 3, state: record.state, summary: `${effect} outcome is uncertain; inspection is required`, effect: output } };
    }
    refs.push({ effect, seq: output.seq, key: output.key });
    return output;
  };

  const pending = await ledgerStore.withLock(unit, async ledger => {
    const rows = await ledger.read();
    return rows.filter(row => row.event === 'intent' && deliveryEffects.has(row.effect)
      && !rows.some(result => result.event === 'result' && result.seq === row.seq));
  });
  for (const intent of pending) {
    const outcome = await run(intent.effect, intent.args);
    if (outcome.stop) return outcome.stop;
    reconciled.set(intent.key, outcome);
    if (intent.effect === 'git.integrate') return invalidate(await inspect(record), 'Remote integration reconciled; reacceptance is required');
  }
  const routeFailure = async (effect, output) => {
    if (!['not-applied', 'conflict'].includes(output.result?.status)) return null;
    const reported = output.result.failure ?? {};
    const failed = await createRecoveryStore(stateRoot).record({ store, unit,
      failure: { class: reported.class ?? 'unknown', failurePoint: effect, reason: reported.reason ?? output.result.status,
        evidence: { seq: output.seq, key: output.key }, snapshot: { evidence: record.evidence ?? [], changedPaths: record.changedPaths ?? [], diff: record.diff ?? {} } },
      retryLimit: policy.retry.maxPerSignature, resolverLimit: policy.retry.maxResolver,
      needsDiagnosis: reported.needsDiagnosis === true, adapters });
    return { code: 3, state: failed.record.state, summary: `${effect} requires ${failed.decision.action}`, failure: failed.reference };
  };

  // A completed commit can precede the durable Unit binding after an interrupted write.
  if (record.accepted.headTree !== record.accepted.tree) {
    const before = { ...record.accepted };
    const args = { repo: before.repo, branch: before.branch, tree: before.tree, parent: before.head, message: plan.message };
    const key = prepareEffect('git.commit', args).key;
    const rows = await ledgerStore.withLock(unit, ledger => ledger.read());
    const prior = rows.findLast(row => row.event === 'intent' && row.effect === 'git.commit' && row.key === key);
    const changed = await stale();
    if (changed && !prior) return invalidate(changed, 'Accepted target changed before commit');
    if (!prior) {
      const target = await inspect(record);
      if (target.indexTree !== before.tree) return invalidate(target, 'Commit index differs from accepted tree');
    }
    const output = await run('git.commit', args);
    if (output.stop) return output.stop;
    const postCommit = await inspect(record);
    if (postCommit.contentFingerprint !== before.contentFingerprint || postCommit.tree !== before.tree || postCommit.indexTree !== before.tree) {
      return invalidate(postCommit, 'Commit hook changed accepted content; reacceptance is required');
    }
    const routed = await routeFailure('git.commit', output);
    if (routed) return routed;
    const bound = bindDeliveryCommit(before, before, output.result);
    const target = await inspect(record);
    if (!bound.valid || target.head !== output.result.sha || target.tree !== before.tree
      || target.headTree !== before.tree || target.headParent !== before.head
      || target.indexTree !== before.tree || target.contentFingerprint !== before.contentFingerprint
      || target.repo !== before.repo || target.branch !== before.branch || target.base !== before.base) {
      return invalidate(target, 'Commit hook or delivery commit changed accepted content; reacceptance is required');
    }
    await ledgerStore.withLock(unit, async ledger => {
      const entries = await ledger.read();
      if (!entries.some(row => row.event === 'binding' && row.seq === output.seq)) await ledger.append({ event: 'binding', unit,
        seq: output.seq, key: output.key, ...bound.binding, contentFingerprint: before.contentFingerprint, bound_at: adapters.now() });
    });
    record = await store.update(unit, current => {
      if (current.accepted?.head !== before.head) throw failure('DELIVERY_HEAD_MISMATCH', 'accepted head changed while binding commit');
      return { ...current, head: bound.accepted.head, accepted: { ...bound.accepted, headTree: before.tree } };
    });
  }
  let changed = await stale();
  if (changed) return invalidate(changed, 'Accepted target changed and requires revalidation');
  let mergeHead = null;
  if (['push', 'pr', 'merge'].includes(requestedDelivery)) {
    const args = { repo: plan.repo, branch: plan.branch, head: record.accepted.head };
    const output = await run('git.push', args);
    if (output.stop) return output.stop;
    if (output.result?.status === 'remote-ahead') {
      if (typeof output.result.remoteHead !== 'string' || !output.result.remoteHead) throw failure('ADAPTER_INVALID', 'remote-ahead push requires the observed remote head');
      const integrated = await run('git.integrate', { ...args, remoteHead: output.result.remoteHead });
      if (integrated.stop) return integrated.stop;
      const routed = await routeFailure('git.integrate', integrated);
      if (routed) return routed;
      return invalidate(await inspect(record), 'Remote changes integrated; reacceptance is required before retrying push');
    }
    const routed = await routeFailure('git.push', output);
    if (routed) return routed;
  }
  if (['pr', 'merge'].includes(requestedDelivery)) {
    changed = await stale();
    if (changed) return invalidate(changed, 'Accepted target changed before PR');
    const args = { repo: plan.repo, branch: plan.branch, head: record.accepted.head, base: plan.base, title: plan.title, body: plan.body };
    const output = await run('pr.create', args);
    if (output.stop) return output.stop;
    const routed = await routeFailure('pr.create', output);
    if (routed) return routed;
    const pr = output.result;
    if (pr?.status !== 'open' || !pr.pr || ['repo', 'branch', 'head', 'base'].some(field => pr[field] !== args[field])) throw failure('ADAPTER_INVALID', 'PR result must match the exact open accepted target');
    if (requestedDelivery === 'merge') {
      const merged = await run('pr.merge', { repo: plan.repo, pr: pr.pr, head: record.accepted.head, base: plan.base });
      if (merged.stop) return merged.stop;
      const routedMerge = await routeFailure('pr.merge', merged);
      if (routedMerge) return routedMerge;
      if (merged.result?.base !== plan.base) throw failure('DELIVERY_HEAD_MISMATCH', 'merge result base differs from authorized base');
      mergeHead = bindMergeResult(record.accepted, record.accepted, merged.result).deliveryResult.mergeHead;
    }
  }
  record = await ledgerStore.withLock(unit, async ledger => store.update(unit, async current => {
    if (!validAcceptance(current) || !validateAcceptedContent(current.accepted, await inspect(current)).valid) {
      const invalid = { ...current, accepted: null, reviewDecision: null, deliveryResult: null, terminalProjection: null };
      return current.state === 'SelfGated' ? invalid : transitionRecord(invalid, 'SelfGated');
    }
    if (current.state !== 'Delivering') throw failure('INVALID_TRANSITION', 'delivery state changed concurrently');
    const bindings = await ledger.read();
    const commitRefs = bindings.filter(row => row.event === 'binding' && row.afterHead === current.accepted.head)
      .map(row => ({ effect: 'git.commit', seq: row.seq, key: row.key }));
    const effectRefs = [...new Map([...commitRefs, ...refs].map(ref => [ref.seq, ref])).values()];
    return transitionRecord({ ...current, deliveryResult: { level: requestedDelivery, head: current.accepted.head, mergeHead, effectRefs } }, 'Delivered');
  }));
  return { code: record.state === 'Delivered' ? 0 : 1, state: record.state, summary: record.state === 'Delivered' ? 'Delivery complete' : 'Accepted target changed during delivery' };
}
