# 0038 — Supported fresh threads and terminal non-started reviews

## Context

Codex 0.167.1 reports the same pre-input thread-not-loaded/no-rollout errors as 0.167.0. The upstream [release comparison](https://github.com/openai/codex/compare/rust-v0.167.0...rust-v0.167.1), from `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a` to `0a94398fa60c4fac0e7659e4213a0a36e613dd46`, changes neither the rollout recorder, observer request processors, queue/goal stores nor composer. Exact supported versions remain necessary; an arbitrary RPC failure is not absence proof.

A stopped implementation can have a blocked goal and an unregistered reviewer whose original start remains uncertain. Owner recovery requires settled reviews, while startup recovery requires an active goal and changed execution policy. Those conditions form a recovery cycle even after the reviewer is positively proven never to have started and irreversibly closed.

## Decision

The fresh-thread observation admits exactly 0.167.0 and 0.167.1. It records the actual platform version and requires the matching full native welcome view, original no-input launch, native identity, structured errors and supported owned queue/goal stores. Existing submission and confirmation fences remain authoritative.

Public `unit session-recover` has a settlement-only branch for an unregistered InReview reviewer under its current blocked goal and Stopped target. It requires the ordinary source-backed approval and terminal non-start verifier, bound additionally to the complete stopped target. No execution-policy change is required because settlement neither selects nor launches a replacement. The ledger appends a `session-start-recovery` observation with `settled: true`, the exact reviewer/target/source bindings and next attempt number; `nextArgs` and `nextKey` are null. It retires only the original intent, without a result, task-start, review verdict or close receipt. Unit and goal records remain unchanged.

Custody recovery recognizes this observation only for the unchanged unregistered reviewer with all its effects settled. Source/goal/target-unit bindings and the original retired intent remain mandatory. A registered, started, live, queued, foreign, uncertain or changed reviewer cannot use this exception. Subsequent ordinary goal/unit recovery remains mandatory. Once the target returns to InReview, the same reviewer unit starts its next attempt using the then-current goal snapshot and target, preserving the failed attempt. The public recovery never starts that attempt itself.

## Consequences

Original evidence and failure histories remain available. Single-ledger append makes interrupted settlement replayable without a cross-record commit. Custody checks acquire reviewer ledgers without waiting: startup/recovery holds that ledger before requesting the target, so waiting while holding target/goal would invert the lock order. A busy reviewer fails closed with `EFFECT_UNCERTAIN`; ordinary ledger writers retain blocking acquisition. Concurrent owner recovery cannot pass an unfinished settlement, and a subsequent reviewer attempt makes custody unsettled again. Active-goal policy-change recovery retains its existing reservation contract.
