export function orcaGoalScreen(terminal, sessionId, fresh) {
  if (terminal?.source !== 'screen' || terminal.handle !== sessionId)
    throw new Error('Orca rendered screen is unavailable');
  // truncated describes retained history; limited fences the current rendered response.
  if (fresh && (typeof terminal.truncated !== 'boolean' || terminal.limited !== false
    || !Array.isArray(terminal.tail) || terminal.tail.some(line => typeof line !== 'string')
    || terminal.returnedLineCount !== terminal.tail.length))
    throw new Error('Complete fresh Orca rendered receiver evidence is unavailable');
  return { screen: Array.isArray(terminal.tail) ? terminal.tail.join('\n') : terminal.tail, renderedDraft: terminal.draft };
}
