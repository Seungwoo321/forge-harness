# 0061 — Codex 0.169.1 fresh-thread observation

## Context

A newly launched Codex 0.169.1 receiver is Ready but its rollout remains deferred. The exact-version fences intentionally reject its unloaded-thread proof before native goal submission. A real original pending start therefore remains unverified without input; absence of a rollout alone cannot establish empty history.

## Decision

Admit exactly 0.169.1 alongside the versions accepted by ADR 0043 at all four boundaries: native pre-return observation, task transport, durable-submission validation and native composer validation. Retain all independent account, owned store/schema, exact RPC-error, empty per-thread queue/goal, PID/thread, matching full native welcome, rendered Ready, line-editing, packet and submission-fence checks. Unknown patch versions, custom builds and mismatched native views remain rejected. The original pending intent and receiver must be reconciled rather than replaced.

## Evidence

Exact Git blob comparison of the upstream `rust-v0.169.0` and `rust-v0.169.1` trees preserves the thread read/goal/queue processors, deferred rollout recorder, goal storage and migrations, goal actions, composer/input flow and keymap contract. The comparison endpoint reports diverged release branches, so the contract evidence uses exact tree blobs rather than treating a merge-base comparison as an exact tag diff.

The existing adapter tests cover the new version through native observation and first-input recovery, durable task validation and matching native composer submission. Negative cases preserve unsupported 0.169.2/0.170.0/custom versions, mismatched welcomes, pending queues, races and unsupported stores. A source-only read-only observation of an actual 0.169.1 empty receiver must confirm its exact contract and Ready view before release; it never submits input or claims task startup.
