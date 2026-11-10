# 0029 — Recover missing goal binding without rewriting authority history

## Context

A submitted unit can lack its initial goal binding. Existing start replay rejects a changed goalId, goal-bind only permits unscoped units or verified successors, and custody adoption requires an existing goal binding. Reopening preserves completed stages, so it cannot turn the unit into an eligible unscoped unit. Historical units may also lack a session policy.

An operator message can be incorrectly recorded as human scope approval. Message-role provenance alone does not establish the human's authority or the meaning of the instruction. Repeating additive scope amendments does not correct their provenance.

## Decision

A public `unit scope approval-correct` appends a correction bound to the full original amendment, current unit/target and a trusted original human instruction. It changes neither the original amendment nor scope paths, stages, failures, gate evidence or prior review. The provider must verify original human authority in its conversational context, not merely an operator message or request-file assertion. Replays are idempotent; stale, unauthorized or changed requests fail before mutation.

The existing goal-bind command has an explicit recovery request for an unbound, undelivered Accepted change unit. It verifies exact current unit/goal snapshots, immutable source and target, unresolved effects and source-backed approval. The goal lock remains held through the unit's atomic commit. Historical policies are retained; the approved goal policy supplies future execution settings. The unit alone gains goal metadata and an append-only binding receipt. Binding grants no native ownership, task receipt, transfer or close authority. Existing session-adopt and normal acceptance/finish remain required.

Original startup intent, failure and authority history remain visible. No record reset, replacement work unit, manufactured approval or installed-copy patch is a recovery mechanism.
