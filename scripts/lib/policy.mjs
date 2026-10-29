import { createHash } from 'node:crypto';

const classes = new Set(['task', 'product-prelaunch', 'product-live']);
const sources = ['user', 'unit', 'project', 'workspace', 'global'];
const levels = ['E0', 'E1', 'E2', 'E3', 'E4'];
const deliveryRank = { none: 0, commit: 1, push: 2, pr: 3, merge: 4 };

const effects = {
  'git.commit': ['E2', ['repo', 'branch', 'tree', 'parent'], 'commit'],
  'git.integrate': ['E2', ['repo', 'branch', 'head', 'remoteHead'], 'push'],
  'dependency.install': ['E2', ['repo', 'lockDigest', 'toolVersion']],
  'generator.run': ['E2', ['repo', 'generator', 'inputDigest']],
  'db.local.change': ['E2', ['database', 'migrationDigest']],
  'git.push': ['E3', ['repo', 'branch', 'head'], 'push'],
  'pr.create': ['E3', ['repo', 'branch', 'head', 'base'], 'pr'],
  'pr.merge': ['E3', ['repo', 'pr', 'head', 'base'], 'merge'],
  'tracker.sync': ['E3', ['adapter', 'ref', 'projectionRevision']],
  'notification.send': ['E3', ['recipient', 'decisionId']],
  'deployment.apply': ['E3', ['environment', 'artifactDigest']],
  'db.migrate': ['E3', ['database', 'migrationDigest']],
  'session.start': ['E3', ['unit', 'role', 'attempt']],
  'session.close': ['E3', ['session', 'incarnation']],
  'data.delete': ['E4', ['resource', 'selectionDigest']],
};

function get(value, dotted) {
  return dotted.split('.').reduce((part, key) => part?.[key], value);
}

function set(target, dotted, value) {
  const keys = dotted.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[keys.at(-1)] = value;
}

function globRegex(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function matches(value, pattern) {
  if (typeof value !== 'string' || typeof pattern !== 'string') return false;
  return globRegex(pattern).test(value);
}

function defaultClass(policy, context) {
  const explicit = get(policy, 'goal.class');
  if (explicit !== undefined) return explicit;
  for (const rule of get(policy, 'goal.defaults') ?? []) {
    const match = rule.match ?? {};
    if ((!match.cwd || matches(context.projectRoot, match.cwd))
      && (!match.remote || matches(context.remote, match.remote))) return rule.class;
  }
  return undefined;
}

function defaultReview(goalClass) {
  if (goalClass === 'product-prelaunch') return { mode: 'none', by: 'session', triggers: [] };
  const triggers = goalClass === 'product-live'
    ? ['risk-kind', 'out-of-scope', 'unproven-gate', 'repeated-signature']
    : ['risk-kind', 'out-of-scope', 'unproven-gate'];
  return { mode: 'conditional', by: 'session', triggers };
}

export function validatePolicy(policy) {
  const known = new Set([
    'goal.class', 'goal.defaults', 'authority.allow', 'authority.deny', 'retry.maxPerSignature',
    'retry.maxResolver', 'review.mode', 'review.by', 'review.triggers', 'delivery',
    'checkpoint.retain', 'checkpoint.exclude', 'escalation.canonReviewAt', 'isolation',
  ]);
  for (const dotted of known) {
    const value = get(policy, dotted);
    if (value === undefined) continue;
    if (dotted === 'goal.class' && !classes.has(value)) throw new TypeError(`invalid goal.class: ${value}`);
    if (dotted.startsWith('retry.') && (!Number.isInteger(value) || value < 1 || value > 5)) {
      throw new TypeError(`${dotted} must be an integer from 1 to 5`);
    }
    if (dotted === 'delivery' && !(value in deliveryRank)) throw new TypeError(`invalid delivery: ${value}`);
    if (dotted === 'review.mode' && !['none', 'conditional', 'required'].includes(value)) {
      throw new TypeError(`invalid review.mode: ${value}`);
    }
    if (dotted === 'review.by' && !['session', 'user'].includes(value)) throw new TypeError(`invalid review.by: ${value}`);
    if (['authority.allow', 'authority.deny', 'review.triggers', 'checkpoint.exclude'].includes(dotted)
      && !Array.isArray(value)) throw new TypeError(`${dotted} must be an array`);
    if (dotted === 'isolation' && !['worktree', 'shared'].includes(value)) throw new TypeError(`invalid isolation: ${value}`);
    if (['authority.allow', 'authority.deny'].includes(dotted)
      && value.some(item => typeof item !== 'string' || (!effects[item] && !levels.includes(item)))) {
      throw new TypeError(`${dotted} must contain registered effects or effect classes`);
    }
    if (dotted === 'goal.defaults') {
      if (!Array.isArray(value)) throw new TypeError('goal.defaults must be an array');
      for (const rule of value) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)
          || !rule.match || typeof rule.match !== 'object' || Array.isArray(rule.match)
          || !classes.has(rule.class)
          || Object.keys(rule.match).some(key => !['cwd', 'remote'].includes(key))
          || Object.values(rule.match).some(pattern => typeof pattern !== 'string' || !pattern)) {
          throw new TypeError('goal.defaults entries require a valid match and class');
        }
      }
    }
  }
  const allowedTop = new Set(['goal', 'authority', 'retry', 'review', 'delivery', 'checkpoint', 'escalation', 'isolation']);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some(key => !allowedTop.has(key))) throw new TypeError('policy contains unsupported fields');
  const allowedChildren = {
    goal: new Set(['class', 'defaults']), authority: new Set(['allow', 'deny']), retry: new Set(['maxPerSignature', 'maxResolver']),
    review: new Set(['mode', 'by', 'triggers']), checkpoint: new Set(['retain', 'exclude']), escalation: new Set(['canonReviewAt']),
  };
  for (const [key, fields] of Object.entries(allowedChildren)) {
    const value = policy[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !fields.has(field)))) throw new TypeError(`invalid ${key} policy fields`);
  }
  if (policy.review?.triggers?.some(value => !['risk-kind', 'out-of-scope', 'unproven-gate', 'repeated-signature'].includes(value))) {
    throw new TypeError('review.triggers contains an unsupported value');
  }
  if (policy.checkpoint?.retain !== undefined && policy.checkpoint.retain !== 'keep'
    && (typeof policy.checkpoint.retain !== 'string' || !/^P(?:\d+D|\d+W|\d+M)$/.test(policy.checkpoint.retain))) {
    throw new TypeError('checkpoint.retain must be keep or an ISO period');
  }
  if (policy.escalation?.canonReviewAt !== undefined
    && (!Number.isInteger(policy.escalation.canonReviewAt) || policy.escalation.canonReviewAt < 1)) {
    throw new TypeError('escalation.canonReviewAt must be a positive integer');
  }
}

export function resolvePolicy({ global = {}, workspace = {}, project = {}, unit = {}, user = {} } = {}, context = {}) {
  const resolved = {};
  const policySources = {};
  const fields = [
    'goal.class', 'authority.allow', 'authority.deny', 'retry.maxPerSignature', 'retry.maxResolver',
    'review.mode', 'review.by', 'review.triggers', 'delivery', 'checkpoint.retain',
    'checkpoint.exclude', 'escalation.canonReviewAt', 'isolation',
  ];

  for (const field of fields) {
    for (const source of sources) {
      const policy = ({ user, unit, project, workspace, global })[source];
      let value = get(policy, field);
      if (field === 'goal.class' && value === undefined && ['workspace', 'global'].includes(source)) {
        value = defaultClass(policy, context);
      }
      if (value !== undefined) {
        set(resolved, field, structuredClone(value));
        policySources[field] = source;
        break;
      }
    }
  }

  if (resolved.goal?.class === undefined) {
    if (context.nonInteractive) {
      set(resolved, 'goal.class', 'task');
      policySources['goal.class'] = 'unconfirmed-default';
    } else {
      const error = new Error('goal.class is not configured');
      error.code = 'POLICY_UNSET';
      error.exitCode = 3;
      throw error;
    }
  }
  if (!classes.has(resolved.goal.class)) throw new TypeError(`invalid goal.class: ${resolved.goal.class}`);

  resolved.delivery ??= 'none';
  policySources.delivery ??= 'default';
  resolved.retry ??= {};
  resolved.retry.maxPerSignature ??= 2;
  resolved.retry.maxResolver ??= 2;
  resolved.review ??= defaultReview(resolved.goal.class);
  resolved.authority ??= { allow: [], deny: [] };
  resolved.authority.allow ??= [];
  resolved.authority.deny ??= [];
  validatePolicy(resolved);
  return { policy: resolved, policySources };
}

export function effectDefinition(effect) {
  const definition = effects[effect];
  if (!definition) {
    const error = new Error(`unregistered effect: ${effect}`);
    error.code = 'EFFECT_UNREGISTERED';
    throw error;
  }
  return { class: definition[0], keyFields: [...definition[1]], delivery: definition[2] ?? null };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export function prepareEffect(effect, args, requested = {}) {
  const definition = effectDefinition(effect);
  if (Object.hasOwn(requested, 'class') || Object.hasOwn(requested, 'key') || Object.hasOwn(requested, 'result')) {
    throw new TypeError('caller cannot override effect class, key, or result');
  }
  for (const field of definition.keyFields) {
    if (args?.[field] === undefined || args?.[field] === null) throw new TypeError(`missing effect key field: ${field}`);
  }
  const key = Object.fromEntries(definition.keyFields.map(field => [field, args[field]]));
  const digest = createHash('sha256').update(JSON.stringify(stable(key))).digest('hex');
  return { class: definition.class, effect, key: `sha256:${digest}`, args };
}

function baselineAllowed(goalClass, effectClass, context) {
  if (effectClass === 'E0') return true;
  if (effectClass === 'E1' || effectClass === 'E2') {
    return goalClass === 'product-prelaunch' ? context.productOwned === true : context.inScope === true;
  }
  if (effectClass === 'E4') return goalClass === 'product-prelaunch' && context.productOwned === true;
  if (goalClass === 'product-prelaunch') return context.productOwned === true;
  if (goalClass === 'product-live' && context.operational === true) return false;
  return context.explicitUserInstruction === true;
}

export function authorizeEffect(policy, effect, context = {}) {
  const definition = effectDefinition(effect);
  const effectClass = context.irreversible === true ? 'E4' : definition.class;
  if (context.resourceOwned === false || context.containsSecret === true || context.forbiddenCommand === true) {
    return { allowed: false, reason: 'invariant boundary' };
  }
  const authority = policy.authority ?? {};
  const denied = new Set(authority.deny ?? []);
  const allowed = new Set(authority.allow ?? []);
  if (denied.has(effect) || denied.has(definition.class) || denied.has(effectClass)) return { allowed: false, reason: 'policy deny' };
  const classAllowed = baselineAllowed(policy.goal.class, effectClass, context);
  if (!classAllowed && !allowed.has(effect) && !allowed.has(effectClass)) {
    return { allowed: false, reason: `goal.class ${policy.goal.class} denies ${effectClass}` };
  }
  if (definition.delivery && deliveryRank[policy.delivery ?? 'none'] < deliveryRank[definition.delivery]) {
    return { allowed: false, reason: `delivery policy is below ${definition.delivery}` };
  }
  return { allowed: true, reason: 'policy allows effect' };
}

export { effects as effectRegistry, levels as effectClasses };
