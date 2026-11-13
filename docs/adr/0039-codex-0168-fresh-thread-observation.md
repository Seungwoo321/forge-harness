# 0039 — Codex 0.168.0 fresh-thread observation

## Context

Codex 0.168.0 reports the same pre-input structured thread-not-loaded/no-rollout errors as the versions admitted by ADR 0038. A fresh managed receiver remains Ready, owns its native thread and opens the supported queue and goal stores, but an observer cannot read a rollout before the first input. The exact-version fences reject the platform before the existing independent storage and native-view checks run.

The upstream [0.167.1 → 0.168.0 comparison](https://github.com/openai/codex/compare/rust-v0.167.1...rust-v0.168.0) includes account-scoping metadata and thread-list cursor changes in the rollout recorder. It preserves the deferred file-creation/write path. Queue and goal runtime storage, goal migrations, input-flow and goal-menu handling, and the hook-list tests are unchanged. Goal and queue processors rename a model-provider validation call outside the unloaded-thread observation path. Composer changes expose existing helpers and add shell-mode draft metadata; they do not replace the plain native `/goal` input contract.

Read-only native observations under 0.168.0 confirm the expected account, RPC -32600 thread-read/turn errors, RPC -32603 queue error, the supported queue and goal schemas with no per-thread rows, and trusted synchronous startup/stop hooks. These observations establish compatibility for this exact version; they do not establish that an arbitrary later version or lookup failure means an empty thread.

## Decision

The fresh-thread observer, transport, durable-submission validation and native composer admit exactly 0.167.0, 0.167.1 and 0.168.0. The proof records the actual platform and the composer requires its matching complete welcome view. The original no-input launch, PID/thread/account binding, structured errors, supported owned storage, empty per-thread queue/goal and unchanged native readiness checks remain mandatory.

Existing intents and receivers resume through the same public command. Submission, correction and Return fences retain their existing semantics. There is no new fallback, synthetic thread history, manual goal submission or permission to retry an uncertain mutation.

## Consequences

0.168.0 can enter the existing positively verified first-input path. Unknown patch versions, custom version suffixes, foreign or mismatched welcome views, queues, native goals, unsupported schemas and changed owners remain blocked. Existing recovery tests cover reuse of the original receiver and intent with one durable submission and one Return; positive platform coverage includes 0.168.0.
