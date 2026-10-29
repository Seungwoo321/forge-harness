import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const packetFields = [
  '목표:', '수용 기준:', '작업관리:', '결정:', '변경:', '검증:', '남은 일·위험:', '다음 단위 첫 행동:',
];
const stopClasses = new Set(['product', 'harness', 'environment', 'user-domain', 'unknown', 'authority', 'authentication', 'limit', 'user-decision', 'external-approval', 'external-input']);
let tempSequence = 0;

function lineValue(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty single line`);
  }
  return value.trim();
}

function lines(value) {
  if (Array.isArray(value)) return value.map(item => lineValue(item, 'list item'));
  return [lineValue(value, 'value')];
}

function outcomeLine(outcome) {
  if (!outcome || typeof outcome !== 'object') throw new TypeError('result outcome is required');
  if (outcome.kind === 'next') {
    return `단위 종료 — 인계: ${lineValue(outcome.path, 'handoff path')} · 다음: ${lineValue(outcome.unit, 'successor unit')}`;
  }
  if (outcome.kind === 'complete') return '단위 종료 — 완료';
  if (outcome.kind === 'stopped') {
    if (!stopClasses.has(outcome.classification)) throw new TypeError('unsupported stop classification');
    return `단위 종료 — 중단: ${lineValue(outcome.classification, 'classification')} · 재개: ${lineValue(outcome.resumeCondition, 'resume condition')}`;
  }
  throw new TypeError('blocked units cannot emit a terminal result');
}

export function formatUnitResult({ title, objective, acceptance, tracking, decision, changed, verification, remainingRisk, nextFirstAction, outcome }) {
  const output = [
    `# ${lineValue(title, 'title')}`,
    `목표: ${lineValue(objective, 'objective')}`,
    `수용 기준: ${lineValue(acceptance, 'acceptance')}`,
    `작업관리: ${lineValue(tracking, 'tracking')}`,
    `결정: ${lineValue(decision, 'decision')}`,
    `변경: ${lines(changed).join(', ')}`,
    `검증: ${lineValue(verification, 'verification')}`,
    `남은 일·위험: ${lineValue(remainingRisk, 'remaining risk')}`,
    `다음 단위 첫 행동: ${lineValue(nextFirstAction, 'next first action')}`,
    outcomeLine(outcome),
  ].join('\n');
  validateUnitResult(output);
  return output;
}

export function validateUnitResult(content) {
  if (typeof content !== 'string' || content.length === 0) throw new TypeError('result file must be non-empty text');
  const normalized = content.replace(/\r\n/g, '\n');
  const rows = (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
  if (rows.length > 30) throw new RangeError('result file must contain at most 30 lines');
  const final = rows.at(-1);
  const valid = final === '단위 종료 — 완료'
    || /^단위 종료 — 인계: .+ · 다음: .+$/.test(final)
    || /^단위 종료 — 중단: .+ · 재개: .+$/.test(final);
  if (!valid) throw new TypeError('result file must end with a canonical unit outcome');
  return { lines: rows.length, outcome: final };
}

export function validateHandoffPacket(content) {
  if (typeof content !== 'string' || content.length === 0) throw new TypeError('handoff packet must be non-empty text');
  const rows = content.replace(/\r\n/g, '\n').split('\n');
  if (rows.length > 30) throw new RangeError('handoff packet must contain at most 30 lines');
  const missing = packetFields.filter(field => !rows.some(row => row.startsWith(field) && row.slice(field.length).trim()));
  if (missing.length) {
    const error = new TypeError(`handoff packet is missing fields: ${missing.join(', ')}`);
    error.code = 'HANDOFF_PACKET_INVALID';
    error.missing = missing;
    throw error;
  }
  return { lines: rows.length, fields: [...packetFields] };
}

export function prepareSuccessor({ record, handoff, successor, parentSessionId }) {
  if (!record || record.state !== 'Delivered') throw new Error('successor handoff requires a Delivered unit');
  if ((record.openDecisions ?? []).length > 0) throw new Error('unresolved decisions prevent successor handoff');
  const packet = validateHandoffPacket(handoff);
  const result = validateUnitResult(record.result);
  if (!successor || successor.approved !== true || typeof successor.unit !== 'string' || !successor.unit) {
    throw new Error('successor must be explicitly approved');
  }
  if (successor.sessionId && successor.sessionId === parentSessionId) {
    throw new Error('successor must run in a new session');
  }
  if (record.tracker && record.tracker.projected !== true) throw new Error('tracker projection must succeed before handoff');
  return {
    unit: successor.unit,
    handoff: { path: lineValue(successor.handoffPath, 'handoff path'), digest: lineValue(successor.handoffDigest, 'handoff digest') },
    result: result.outcome,
    packetLines: packet.lines,
    session: 'new',
  };
}

export async function writeUnitResult(stateRoot, slug, content) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug === '.' || slug === '..') {
    throw new TypeError('slug must be a path-safe identifier');
  }
  validateUnitResult(content);
  const directory = path.join(path.resolve(stateRoot), 'handoff');
  const target = path.join(directory, `${slug}-result.md`);
  await mkdir(directory, { recursive: true });
  tempSequence += 1;
  const temporary = `${target}.tmp-${process.pid}-${tempSequence}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${content}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return target;
  } catch (error) {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export function formatCliResult({ code, summary, details = {} }) {
  if (!Number.isInteger(code) || ![0, 1, 2, 3, 4, 20].includes(code)) throw new TypeError('unsupported result code');
  if (!details || typeof details !== 'object' || Array.isArray(details)
    || Object.hasOwn(details, 'code') || Object.hasOwn(details, 'summary')) {
    throw new TypeError('result details cannot override code or summary');
  }
  const human = lineValue(summary, 'summary');
  return `${human}\nRESULT ${JSON.stringify({ code, summary: human, ...details })}`;
}
