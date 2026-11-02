# Explicit finding resolution and scope revalidation

## Context

Review findings are append-only. A matching ship review cannot itself prove which older findings were fixed. Acceptance discarded that review when historical findings blocked it. Prelaunch scope checks also ignored explicit unit scope when no wider product boundary was recorded.

## Decision

Prelaunch uses an explicitly recorded product boundary when present, including an empty deny-all boundary. Otherwise it uses the confirmed unit scope. The public `unit scope recheck` command revalidates only generated scope findings against that existing authority. It preserves original bodies, records their indexes and digests in an audit receipt, and never adds authorized paths or resolves reviewer-authored findings.

`unit finding resolve` accepts an exact revision-bound batch of reviewer-authored review or coverage findings, their original digests, the completed review input/output, current source identity, reviewer identity and independent repair evidence. The trusted provider verifies the exact authorization, actual reviewer independence, provenance and each claimed fix. Classification describes the cause and does not substitute for resolution authority. Generated findings remain with their deterministic owners.

Matching ship reviews survive an acceptance failure caused by unresolved findings. Recovery of an older cleared ship requires the original completed ship review, the same source and acceptance evidence, no subsequent implementation or review, and the same trusted resolution verification. A newer fix or changed target cannot be overwritten. Exact retries return the original receipt; stale, conflicting or partially invalid batches do not write. Acceptance stays a separate public command.

## Consequences

Original findings, stages, gate evidence, failure history and retry limits remain intact. Ship alone, self-declared reviewer identity, manual state edits, broader scope and replacement units cannot stand in for verified recovery.
