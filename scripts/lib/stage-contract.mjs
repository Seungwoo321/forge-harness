import { isDeepStrictEqual } from 'node:util';

const contractVersion = 'harness.contract/1';
const schemaVersion = 'harness.schema/1';
const stages = new Set(['scope', 'implement', 'root-cause', 'review', 'handoff']);
const contractKeys = new Set([
  'contractVersion', 'schemaVersion', 'stage', 'reads', 'writes', 'input', 'output',
]);
const schemaKeys = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'additionalProperties',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);
const schemaTypes = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const recordFields = new Set([
  'schema', 'unit', 'revision', 'request', 'kind', 'goal', 'state', 'blockedFrom',
  'stoppedFrom', 'isolation', 'policyRef', 'policyOverrides', 'userOverrides',
  'policy', 'policySources', 'canon', 'scopePaths', 'acceptance', 'stages',
  'changedPaths', 'diff', 'handoff', 'feedback', 'coverage', 'riskAssessment',
  'evidence', 'findings', 'verdict', 'reviewedHead', 'reviewDecision', 'accepted',
  'deliveryResult', 'approvals', 'assumptions', 'openDecisions', 'failures',
  'tracker', 'next',
]);

function issue(path, keyword, message) {
  return { path, keyword, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function validateSchemaDefinition(schema, at, issues) {
  if (!isObject(schema)) {
    issues.push(issue(at, 'type', 'schema must be an object'));
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!schemaKeys.has(key)) issues.push(issue(`${at}.${key}`, 'unsupported', `unsupported schema keyword: ${key}`));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some(type => !schemaTypes.has(type))) issues.push(issue(`${at}.type`, 'enum', 'type must use the harness.schema/1 vocabulary'));
  if (types.includes('object')) {
    if (!isObject(schema.properties)) issues.push(issue(`${at}.properties`, 'type', 'object schemas require properties'));
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      issues.push(issue(`${at}.additionalProperties`, 'const', 'additionalProperties supports only false when declared'));
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(name => typeof name === 'string'))) {
      issues.push(issue(`${at}.required`, 'type', 'required must be an array of property names'));
    } else if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!schema.properties || !Object.hasOwn(schema.properties, name)) {
          issues.push(issue(`${at}.required`, 'property', `required property ${name} must be declared`));
        }
      }
    }
    if (isObject(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        validateSchemaDefinition(child, `${at}.properties.${name}`, issues);
      }
    }
  }
  if (types.includes('array')) {
    if (!schema.items) issues.push(issue(`${at}.items`, 'required', 'array schemas require items'));
    else validateSchemaDefinition(schema.items, `${at}.items`, issues);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    issues.push(issue(`${at}.enum`, 'type', 'enum must be a non-empty array'));
  }
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number') {
      issues.push(issue(`${at}.${key}`, 'type', `${key} must be a number`));
    }
  }
}

function matchesType(type, value) {
  if (Array.isArray(type)) return type.some(candidate => matchesType(candidate, value));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(schema, value, at, issues) {
  if (!matchesType(schema.type, value)) {
    issues.push(issue(at, 'type', `must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`));
    return;
  }
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    issues.push(issue(at, 'enum', 'must match one of the declared values'));
  }
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object') && isObject(value))) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) issues.push(issue(`${at}.${name}`, 'required', 'is required'));
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, name) && schema.additionalProperties === false) issues.push(issue(`${at}.${name}`, 'additionalProperties', 'is not declared'));
      else if (!Object.hasOwn(schema.properties, name)) continue;
      else validateValue(schema.properties[name], value[name], `${at}.${name}`, issues);
    }
  } else if (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array') && Array.isArray(value))) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(issue(at, 'minItems', `must contain at least ${schema.minItems} items`));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(issue(at, 'maxItems', `must contain at most ${schema.maxItems} items`));
    value.forEach((item, index) => validateValue(schema.items, item, `${at}[${index}]`, issues));
  } else if (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string') && typeof value === 'string')) {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(issue(at, 'minLength', `must contain at least ${schema.minLength} characters`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(issue(at, 'maxLength', `must contain at most ${schema.maxLength} characters`));
  } else if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(issue(at, 'minimum', `must be at least ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(issue(at, 'maximum', `must be at most ${schema.maximum}`));
  }
}

export function validateStageContract(contract) {
  const issues = [];
  if (!isObject(contract)) return { ok: false, issues: [issue('$', 'type', 'contract must be an object')] };
  for (const key of Object.keys(contract)) {
    if (!contractKeys.has(key)) issues.push(issue(`$.${key}`, 'unsupported', `unsupported contract field: ${key}`));
  }
  if (contract.contractVersion !== contractVersion) issues.push(issue('$.contractVersion', 'version', `expected ${contractVersion}`));
  if (contract.schemaVersion !== schemaVersion) issues.push(issue('$.schemaVersion', 'version', `expected ${schemaVersion}`));
  if (!stages.has(contract.stage)) issues.push(issue('$.stage', 'enum', 'stage is not a supported stage'));
  for (const field of ['reads', 'writes']) {
    if (!uniqueStrings(contract[field])) issues.push(issue(`$.${field}`, 'type', `${field} must contain unique non-empty strings`));
    else {
      for (const name of contract[field]) {
        if (!recordFields.has(name)) issues.push(issue(`$.${field}`, 'field', `unknown Unit Record field: ${name}`));
      }
    }
  }
  validateSchemaDefinition(contract.input, '$.input', issues);
  validateSchemaDefinition(contract.output, '$.output', issues);
  if (isObject(contract.input) && isObject(contract.input.properties?.data)) {
    const inputReads = Object.keys(contract.input.properties.data.properties ?? {});
    if (Array.isArray(contract.reads) && inputReads.sort().join('\0') !== [...contract.reads].sort().join('\0')) {
      issues.push(issue('$.input.properties.data.properties', 'reads', 'data properties must exactly match declared reads'));
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateSchema(schema, value) {
  const issues = [];
  validateSchemaDefinition(schema, '$schema', issues);
  if (issues.length === 0) validateValue(schema, value, '$', issues);
  return { ok: issues.length === 0, issues };
}

export function validateReadiness(contract, { upstreamWriters, preparedValues } = {}) {
  const contractResult = validateStageContract(contract);
  if (!contractResult.ok) return contractResult;
  const issues = [];
  if (!isObject(upstreamWriters) || !isObject(preparedValues)) {
    return { ok: false, issues: [issue('$', 'readiness', 'control-plane writer and prepared-value metadata are required')] };
  }
  for (const field of contract.reads) {
    const writers = upstreamWriters[field];
    if (!Array.isArray(writers) || writers.length === 0 || writers.some(writer => typeof writer !== 'string' || writer.length === 0)) issues.push(issue(`$.reads.${field}`, 'writer', 'no upstream writer is declared'));
    if (!Object.hasOwn(preparedValues, field) || preparedValues[field] === null || preparedValues[field] === undefined) {
      issues.push(issue(`$.data.${field}`, 'prepared', 'a non-null prepared value is required'));
    }
  }
  return { ok: issues.length === 0, issues };
}

export function createStageInput(contract, metadata, readiness) {
  const result = validateReadiness(contract, readiness);
  if (!result.ok) return { ok: false, issues: result.issues };
  const data = Object.fromEntries(contract.reads.map(field => [field, readiness.preparedValues[field]]));
  const input = { ...metadata, stage: contract.stage, data };
  const validation = validateSchema(contract.input, input);
  return validation.ok ? { ok: true, input } : { ok: false, issues: validation.issues };
}

export function validateStageInput(contract, input, readiness) {
  const ready = validateReadiness(contract, readiness);
  if (!ready.ok) return ready;
  const issues = [];
  const schemaResult = validateSchema(contract.input, input);
  issues.push(...schemaResult.issues);
  if (input?.stage !== contract.stage) issues.push(issue('$.stage', 'const', 'must match the stage contract'));
  for (const field of contract.reads) {
    if (!Object.hasOwn(input?.data ?? {}, field) || !isDeepStrictEqual(input.data[field], readiness.preparedValues[field])) {
      issues.push(issue(`$.data.${field}`, 'authority', 'must match the control-plane prepared value'));
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateStageOutput(contract, input, output) {
  const contractResult = validateStageContract(contract);
  if (!contractResult.ok) return contractResult;
  const validation = validateSchema(contract.output, output);
  const issues = [...validation.issues];
  if (output?.inputDigest !== input?.inputDigest) issues.push(issue('$.inputDigest', 'binding', 'must match the opened StageInput'));
  if (output?.attempt !== input?.attempt) issues.push(issue('$.attempt', 'binding', 'must match the opened StageInput'));
  return { ok: issues.length === 0, issues };
}
