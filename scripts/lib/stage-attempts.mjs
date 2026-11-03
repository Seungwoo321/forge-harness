export function attemptsFor(record, stage) {
  const entry = (record.stages ?? []).find(item => item.name === stage);
  if (!entry) return [];
  return entry.attempts ?? (Number.isSafeInteger(entry.attempt) ? [{
    ...entry, n: entry.attempt, endedAt: entry.endedAt ?? entry.submittedAt ?? null,
  }] : []);
}
