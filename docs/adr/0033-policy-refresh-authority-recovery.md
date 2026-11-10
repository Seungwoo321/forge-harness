# 0033. Neutral role maps and execution-policy refresh recovery

## Context

An empty session role map masks inherited role overrides without changing any execution setting. Raw JSON comparison rejects that neutral representation. An applied execution-policy refresh can also carry an incorrect authorization reference; replacing that historical reference would hide the original failure.

## Decision

Semantic execution-policy comparison treats only an empty role map as equivalent to its omission. Persisted policies, immutable snapshots, custody digests and effect keys retain their original representation.

The public goal policy-recover operation restores only the latest refresh's exact previous policy. It requires current goal, submitted unit, target, source and existing native custody bindings and trusted verification of original human authority, the unauthorized current policy and the authorized prior native execution account/settings. It preserves the incorrect row and all unit/effect history and appends a recovery receipt and a superseding policy-change row.

Unit ledger, unit and goal locks serialize recovery with effects, custody, reviewer registration and launch. Goal-bound registration holds its own ledger, any review target and the goal through creation, rechecks the original goal/source/target and rejects a delayed stale create before it can retain a review ID. Reviewer activity, delivery/finalization, uncertain effects, stale sources, conflicting IDs and unsupported authority fail closed. A fresh launch verifies its execution policy against the current goal. Recovery does not launch, adopt, resume or terminate a session or modify shared policy.

## Consequences

Recovery is deliberately restricted to existing custody and a submitted active target with no reviewer activity. Other policy changes use the ordinary approved refresh. Historical provenance remains inspectable; a restored policy does not retroactively authorize the erroneous refresh.
