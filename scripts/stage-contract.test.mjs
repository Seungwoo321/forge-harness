import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createStageInput,
  validateReadiness,
  validateSchema,
  validateStageContract,
  validateStageInput,
  validateStageOutput,
} from './lib/stage-contract.mjs';

const schema = (type, properties, required = []) => ({
  type,
  properties,
  required,
  additionalProperties: false,
});

const contract = {
  contractVersion: 'harness.contract/1',
  schemaVersion: 'harness.schema/1',
  stage: 'scope',
  reads: ['request'],
  writes: ['acceptance'],
  input: schema('object', {
    unit: { type: 'string' },
    targetUnit: { type: 'string' },
    stage: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    inputRevision: { type: 'integer', minimum: 1 },
    inputDigest: { type: 'string' },
    head: { type: 'string' },
    contentFingerprint: { type: 'string' },
    data: schema('object', { request: { type: ['string', 'object'], properties: {} } }, ['request']),
  }, ['unit', 'targetUnit', 'stage', 'attempt', 'inputRevision', 'inputDigest', 'head', 'contentFingerprint', 'data']),
  output: schema('object', {
    inputDigest: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    submissionId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked', 'needs-decision', 'needs-diagnosis'] },
    summary: { type: 'string' },
    result: { type: 'string' },
  }, ['inputDigest', 'attempt', 'submissionId', 'status', 'summary', 'result']),
};

const ready = {
  upstreamWriters: { request: ['control-plane'] },
  preparedValues: { request: 'implement a feature' },
};

test('all stage skill contracts use the supported versioned vocabulary', async () => {
  for (const stage of ['scope', 'implement', 'root-cause', 'review', 'handoff']) {
    const contractFile = new URL(`../skills/${stage}/contract.json`, import.meta.url);
    const declared = JSON.parse(await readFile(contractFile, 'utf8'));
    assert.equal(validateStageContract(declared).ok, true, stage);
  }
});

test('root-cause and review findings accept documented null metadata', async () => {
  const finding = {
    id: 'F-1', kind: 'diagnosis', severity: 'must-fix', site: 'src/example.mjs:4',
    claim: 'The failure is misclassified.', case: 'A report omits a class.', fix: 'Record the resolved class.',
    classification: null, resolvedAt: null,
  };
  for (const stage of ['root-cause', 'review']) {
    const contractFile = new URL(`../skills/${stage}/contract.json`, import.meta.url);
    const declared = JSON.parse(await readFile(contractFile, 'utf8'));
    const findingSchema = declared.output.properties.findings.items;
    assert.equal(validateSchema(findingSchema, finding).ok, true, stage);
  }
});

test('validates versioned contract and exact read data declaration', () => {
  assert.deepEqual(validateStageContract(contract), { ok: true, issues: [] });
  assert.equal(validateStageContract({ ...contract, schemaVersion: 'draft-07' }).ok, false);
  assert.equal(validateStageContract({ ...contract, input: { ...contract.input, $ref: '#/other' } }).issues[0].keyword, 'unsupported');
  assert.equal(validateStageContract({ ...contract, input: schema('object', { data: schema('object', { canon: { type: 'array', items: { type: 'string' } } }, ['canon']) }) }).ok, false);
});

test('requires an upstream writer and a non-null prepared value for every read', () => {
  assert.equal(validateReadiness(contract, ready).ok, true);
  assert.deepEqual(validateReadiness(contract, { upstreamWriters: {}, preparedValues: { request: 'x' } }).issues.map(x => x.keyword), ['writer']);
  assert.equal(validateReadiness(contract, { upstreamWriters: { request: ['scope'] }, preparedValues: { request: null } }).issues[0].keyword, 'prepared');
});

test('constructs input from authoritative prepared data and rejects caller drift', () => {
  const metadata = {
    unit: 'UNIT-1', targetUnit: 'UNIT-1', attempt: 1, inputRevision: 1,
    inputDigest: 'sha256:input', head: 'abc', contentFingerprint: 'sha256:tree',
  };
  const result = createStageInput(contract, metadata, ready);
  assert.equal(result.ok, true);
  assert.deepEqual(result.input.data, { request: 'implement a feature' });
  assert.equal(validateStageInput(contract, result.input, ready).ok, true);
  assert.equal(validateStageInput(contract, { ...result.input, data: { request: 'changed' } }, ready).issues[0].keyword, 'authority');
});

test('validates output schema and binds the submission to its opened input', () => {
  const input = { inputDigest: 'sha256:input', attempt: 1 };
  const output = {
    inputDigest: 'sha256:input', attempt: 1, submissionId: 'SUB-1',
    status: 'done', summary: 'Defined acceptance criteria.', result: 'ok',
  };
  assert.equal(validateStageOutput(contract, input, output).ok, true);
  assert.equal(validateStageOutput(contract, input, { ...output, attempt: 2 }).issues[0].keyword, 'binding');
  assert.equal(validateStageOutput(contract, input, { ...output, unexpected: true }).issues[0].keyword, 'additionalProperties');
});
