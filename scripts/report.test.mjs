import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatCliResult, formatUnitResult, prepareSuccessor, validateHandoffPacket,
  validateUnitResult, writeUnitResult,
} from './lib/report.mjs';

const packet = [
  '# Verification', '목표: verify lifecycle', '수용 기준: all linked scenarios', '작업관리: plan reference',
  '결정: current contract', '변경: scripts/report.mjs', '검증: node tests pass', '남은 일·위험: none',
  '다음 단위 첫 행동: read current spec',
].join('\n');

function result(outcome = { kind: 'next', path: '.local/handoff/next.md', unit: 'verification' }) {
  return formatUnitResult({
    title: 'Implementation', objective: 'complete approved scope', acceptance: 'all linked criteria',
    tracking: 'SDI plan', decision: 'keep current design', changed: ['scripts/report.mjs'],
    verification: 'node --test passed', remainingRisk: 'none', nextFirstAction: 'read latest spec', outcome,
  });
}

test('result formats stay within 30 lines and end with one canonical outcome', () => {
  const text = result();
  assert.equal(validateUnitResult(text).outcome, '단위 종료 — 인계: .local/handoff/next.md · 다음: verification');
  assert.equal(validateUnitResult(result({ kind: 'complete' })).outcome, '단위 종료 — 완료');
  assert.match(validateUnitResult(result({ kind: 'stopped', classification: 'limit', resumeCondition: 'quota resets' })).outcome, /재개: quota resets$/);
  assert.throws(() => validateUnitResult(`${text}\nextra`), /canonical unit outcome/);
  assert.equal(validateUnitResult(`${text}\n`).lines, 10);
  assert.throws(() => result({ kind: 'blocked' }), /cannot emit/);
});

test('handoff packets require every documented field and fit the line limit', () => {
  assert.equal(validateHandoffPacket(packet).lines, 9);
  assert.throws(() => validateHandoffPacket('# short\n목표: x'), error => error.code === 'HANDOFF_PACKET_INVALID');
  assert.throws(() => validateHandoffPacket(`${packet}\n${Array(22).fill('extra').join('\n')}`), /at most 30/);
});

test('successor preparation requires Delivered, complete projection, approval, and a new session', () => {
  const record = { state: 'Delivered', openDecisions: [], result: result(), tracker: { projected: true } };
  assert.equal(prepareSuccessor({ record, handoff: packet, successor: { approved: true, unit: 'next', handoffPath: 'next.md', handoffDigest: 'sha256:x' }, parentSessionId: 's1' }).session, 'new');
  assert.throws(() => prepareSuccessor({ record: { ...record, state: 'Accepted' }, handoff: packet, successor: { approved: true, unit: 'next', handoffPath: 'n', handoffDigest: 'd' } }), /Delivered/);
  assert.throws(() => prepareSuccessor({ record, handoff: packet, successor: { approved: false, unit: 'next', handoffPath: 'n', handoffDigest: 'd' } }), /approved/);
  assert.throws(() => prepareSuccessor({ record, handoff: packet, successor: { approved: true, unit: 'next', handoffPath: 'n', handoffDigest: 'd', sessionId: 's1' }, parentSessionId: 's1' }), /new session/);
  assert.throws(() => prepareSuccessor({ record: { ...record, tracker: { projected: false } }, handoff: packet, successor: { approved: true, unit: 'next', handoffPath: 'n', handoffDigest: 'd' } }), /projection/);
});

test('result files are atomically written under the state handoff directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-report-'));
  try {
    const file = await writeUnitResult(root, 'unit-1', result({ kind: 'complete' }));
    assert.match(file, /handoff\/unit-1-result\.md$/);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').at(-1), '단위 종료 — 완료');
    await assert.rejects(writeUnitResult(root, '../escape', result()), /path-safe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI keeps a machine-readable RESULT line after human output', () => {
  const output = formatCliResult({ code: 3, summary: 'blocked by policy', details: { state: 'Stopped' } });
  assert.match(output, /^blocked by policy\nRESULT \{"code":3,"summary":"blocked by policy","state":"Stopped"\}$/);
  assert.throws(() => formatCliResult({ code: 0, summary: 'ok', details: { code: 42 } }), /code/);
});
