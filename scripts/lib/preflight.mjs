import { authorizeEffect, resolvePolicy } from './policy.mjs';
import { scopeGuard } from './checkpoint.mjs';
import { validateStageContract } from './stage-contract.mjs';

const operations = new Map([
  ['stage.open', 'unit'],
  ['stage.submit', 'unit'],
  ['unit.effect', 'unit'],
  ['unit.resume', 'unit'],
  ['policy.resolve', 'policy'],
  ['policy.detect', 'policy'],
  ['policy.set', 'policy'],
]);

const policyFields = new Set(['schema', 'scope', 'goal', 'authority', 'retry', 'review', 'delivery', 'checkpoint', 'escalation', 'isolation']);
const nestedPolicyFields = {
  goal: new Set(['class', 'defaults']),
  authority: new Set(['allow', 'deny']),
  retry: new Set(['maxPerSignature', 'maxResolver']),
  review: new Set(['mode', 'by', 'triggers']),
  checkpoint: new Set(['retain', 'exclude']),
  escalation: new Set(['canonReviewAt']),
};

function issue(code, path, message) {
  return { code, path, message };
}

function checkPolicyFields(policy, at, issues) {
  for (const key of Object.keys(policy)) {
    const allowed = at === '$' ? policyFields : nestedPolicyFields[at.slice(2)];
    if (!allowed?.has(key)) {
      issues.push(issue('UNSUPPORTED_POLICY_FIELD', `${at}.${key}`, 'policy contains an unsupported field'));
      continue;
    }
    const child = policy[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) checkPolicyFields(child, `${at}.${key}`, issues);
  }
}

function validPolicySources(sources, context, issues) {
  if (!sources) return undefined;
  try {
    return resolvePolicy(sources, context).policy;
  } catch (error) {
    issues.push(issue(error.code ?? 'INVALID_POLICY', '$.policy', error.message));
    return undefined;
  }
}

export function preflightRequest(request) {
  const issues = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, issues: [issue('INVALID_REQUEST', '$', 'request must be an object')] };
  }

  const operation = operations.get(request.operation);
  if (!operation) issues.push(issue('UNSUPPORTED_OPERATION', '$.operation', 'operation is not supported'));
  if (operation && request.protocol !== `harness.${operation}/1`) {
    issues.push(issue('UNSUPPORTED_PROTOCOL', '$.protocol', `expected harness.${operation}/1`));
  }

  if (request.policy !== undefined) {
    if (!request.policy || typeof request.policy !== 'object' || Array.isArray(request.policy)) {
      issues.push(issue('INVALID_POLICY', '$.policy', 'policy must be an object'));
    } else {
      checkPolicyFields(request.policy, '$.policy', issues);
      if (request.policy.schema !== undefined && request.policy.schema !== 'harness.policy/1') {
        issues.push(issue('UNSUPPORTED_POLICY_VERSION', '$.policy.schema', 'policy schema version is not supported'));
      }
      if (request.policy.scope !== undefined && !['project', 'workspace'].includes(request.policy.scope)) {
        issues.push(issue('UNSUPPORTED_POLICY_SCOPE', '$.policy.scope', 'policy scope is not supported'));
      }
    }
  }

  if (request.policySources !== undefined) {
    if (!request.policySources || typeof request.policySources !== 'object' || Array.isArray(request.policySources)) {
      issues.push(issue('INVALID_POLICY', '$.policySources', 'policy sources must be an object'));
    } else {
      for (const [source, policy] of Object.entries(request.policySources)) {
        if (!['global', 'workspace', 'project', 'unit', 'user'].includes(source)) {
          issues.push(issue('UNSUPPORTED_POLICY_SOURCE', `$.policySources.${source}`, 'policy source is not supported'));
        } else if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
          checkPolicyFields(policy, `$.policySources.${source}`, issues);
        }
      }
    }
  }
  const resolvedPolicy = validPolicySources(request.policySources, request.policyContext ?? {}, issues);
  if (request.contract !== undefined) {
    const contract = validateStageContract(request.contract);
    if (!contract.ok) issues.push(...contract.issues.map(item => issue('UNSUPPORTED_CONTRACT', item.path, item.message)));
    if (request.stage !== undefined && request.contract.stage !== request.stage) {
      issues.push(issue('CONTRACT_STAGE_MISMATCH', '$.stage', 'stage does not match its contract'));
    }
  } else if (request.operation === 'stage.open' || request.operation === 'stage.submit') {
    issues.push(issue('CONTRACT_REQUIRED', '$.contract', 'stage operation requires a supported contract'));
  }

  if (request.changedPaths !== undefined) {
    try {
      const scope = scopeGuard({
        changedPaths: request.changedPaths,
        scopePaths: request.scopePaths,
        productPaths: request.productPaths,
        goalClass: request.goalClass ?? resolvedPolicy?.goal?.class,
      });
      if (!scope.ok) issues.push(issue('OUT_OF_SCOPE', '$.changedPaths', `paths outside the allowed scope: ${scope.finding.paths.join(', ')}`));
    } catch (error) {
      issues.push(issue('INVALID_SCOPE', '$.changedPaths', error.message));
    }
  }

  if (request.effect !== undefined && resolvedPolicy) {
    try {
      const authorization = authorizeEffect(resolvedPolicy, request.effect, request.effectContext ?? {});
      if (!authorization.allowed) issues.push(issue('EFFECT_DENIED', '$.effect', authorization.reason));
    } catch (error) {
      issues.push(issue(error.code ?? 'INVALID_EFFECT', '$.effect', error.message));
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}

export async function executePreflighted(request, adapters) {
  const result = preflightRequest(request);
  if (!result.ok) return result;
  const adapter = adapters?.[request.operation];
  if (typeof adapter !== 'function') {
    return { ok: false, issues: [issue('ADAPTER_UNSUPPORTED', '$.operation', 'operation adapter is unavailable')] };
  }
  return { ok: true, value: await adapter(request) };
}
