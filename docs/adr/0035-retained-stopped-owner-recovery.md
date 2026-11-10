# 0035: Recover an externally closed retained stopped owner

## Decision

A retained stopped owner that is explicitly closed outside the session control plane is recovered through `unit stopped-owner-recover`. Recovery requires source-backed authority for the exact closure and same-unit recovery, independent native surface and process absence, immutable stop packets, and current unit, goal, custody, target, policy and ledger bindings. Missing, live, ambiguous, conflicting or stale evidence fails closed.

The control plane serializes recovery with the unit ledger, unit and goal locks. It appends an external-closure observation to the goal without rewriting the stopped unit or fabricating a `session.close` execution receipt. Exact retries revalidate the original preimage and do not append another observation. Goal and unit resume revalidate the observation and preserve stop reports, failures, effects and custody. Unit resume archives the observation in session history; a fresh managed start uses the next attempt and owns the resumed unit. Historical custody remains available but is excluded from current-owner selection after its verified retirement.

## Rationale

A session-close execution receipt proves an effect performed by the control plane. External cleanup proves a different fact and needs a distinct audit record. Allowing absence alone to grant recovery would bypass authority; allowing a new start while selecting the old adoption would assign the next work to a dead owner. A single append-only observation and the existing resume/start flow preserve both provenance and single ownership.
