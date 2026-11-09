# Existing owner custody adoption

## Context

A goal-bound unit can complete public stages in a user-owned session without a managed bootstrap. Submitted units then cannot launch required independent review because the goal has no verified owner. Starting another implementation worker would change ownership and lose the intended recovery boundary.

## Decision

A public session-adopt command registers the actual existing owner in a separate append-only goal adoptions array. Ledger, unit and goal locks serialize the observation and commit. The unit itself is not rewritten. An exact request binds current unit and goal revisions/digests, canonical source, inspected Git target, current goal execution policy, native runtime/cwd/process/thread identity and independently verified source-backed user permission. Existing custody or uncertain effects prevent adoption. Replay verifies the same receipt and live identity without creating another entry.

Current goal policy governs execution even when historical unit session configuration differs. Original unit authority, review and retry policy, criteria amendments/corrections, failures and evidence remain unchanged. Adoption does not assert a managed bootstrap, native goal/task start or hook enforcement. A required reviewer remains a distinct managed session with its normal verified task receipt and public submission.

All owner consumers recognize the distinct custody type and reobserve its native identity before effects. Adopted user sessions and same-session continuations retain existing ownership and are never automatically closed. A managed reviewer returns to that owner and closes only itself. Managed bootstraps and transfers retain their existing contracts.
