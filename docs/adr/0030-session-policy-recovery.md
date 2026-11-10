# 0030 — Recover an uncertain start after execution-policy refresh

## Context

A goal policy refresh changes the immutable goal snapshot but not the unit/role/attempt effect key. Implementation retries regenerated that snapshot and failed the ledger's complete-argument check before observing the original receiver. Observing an old receiver through the new provider account also breaks the trust boundary.

## Decision

Every existing start intent retains its original complete arguments, snapshot and execution account for observation. Goal-policy changes affect future attempts. Source and handoff integrity and current owner/target checks remain required.

`unit session-recover` is a separate, authorized reservation operation. It verifies the original intent and absence of any successful result, exact current unit/goal revisions, a source-backed user instruction, and a trusted read-only proof of terminal non-start. That proof requires that the original task never started, the exact original receiver is stopped, and all associated queued work is cancelled. No screen, authentication error, cleared goal or missing receipt proves this alone. Missing or unsupported verification blocks recovery.

A durable ledger marker retires the original effect key and binds the next attempt to the current goal snapshot. It preserves all original rows and never creates a not-applied or successful result for the old intent. The marker is the only commit point. Replays of a retired key are refused, including through generic effect execution. Repeating the same recovery ID returns its existing reservation. The subsequent ordinary session-start launches or observes that exact reserved attempt.

Start and recovery use ledger → unit → adopted review target → goal locking. Policy refresh uses the same goal lock. Snapshot selection, native observation/mutation and bootstrap registration are fenced by those locks. A changed goal or target fails closed. Existing adopted owner checks continue at the native effect boundary.

## Consequences

A provider must verify native non-start and irreversible receiver/queue quiescence in the original account and runtime. A new account cannot attest old native history by reporting empty state. Hosts without this capability can observe the original attempt but cannot authorize another worker. The recovery protocol is provider neutral and does not edit installed packages or original records manually.
