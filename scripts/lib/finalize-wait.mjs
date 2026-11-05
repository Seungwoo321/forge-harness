// A finalizer whose result is still pending (the owner is busy, so the result packet cannot be delivered or its
// receipt is not yet observable) retries the same idempotent finalization within a bounded window instead of exiting.
// Each attempt re-observes the recorded intent; no new effect is created by waiting.
export async function finalizeWithin(attempt, { waitSeconds = 0, intervalSeconds = 30, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new TypeError('invalid finalize wait bound');
  const deadline = now() + waitSeconds * 1000;
  let result = await attempt();
  let attempts = 1;
  while (result?.finalizePending === true && result.code === 3 && now() + intervalSeconds * 1000 <= deadline) {
    await sleep(intervalSeconds * 1000);
    result = await attempt();
    attempts += 1;
  }
  return { ...result, attempts };
}
