# Recovery of an exited historical review's return transport

## Decision

`unit review-exit-recover` retires only the exact unresolved return-delivery intent of a registered Closed review whose original reviewer and original recipient are independently proven exited and fenced. It requires original user continuation authority, actual replacement caller, the original positive managed startup receipt, a completed submitted review attempt and unchanged immutable stage/result/handoff/goal packets. A delivery submission/result, close intent, another unresolved effect or changed source/custody rejects this path.

Under original review ledger/unit, nonblocking target ledger/unit and goal custody locks, core repeats both native absence observations and current caller binding around trusted approval/full verification. It appends one durable `review-finalization-recovery` audit row. Every original row and original unit/target/goal byte remains unchanged. The row retires only its exact delivery seq/key/intent digest and prevents any later replay.

Historical session-settlement checks share the same immutable audit validation in custody recovery and formal goal finish. The audit preserves the original submitted work and unknown delivery observations; it does not prove delivery, close, non-start or a new review verdict. Historical target identity stays bound to its original submitted packet. The current target still requires its own normal gates, review and acceptance.

## Rationale

A real review can submit before its return transport fails. When both endpoints later exit without a delivery receipt or close intent, neither historical receipt reconstruction nor close reconciliation may invent success. Explicit transport retirement preserves that uncertainty and prevents duplicate external input while allowing authorized continuation of the same goal/unit.
