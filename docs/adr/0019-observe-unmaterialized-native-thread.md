# Observe a fresh native thread before its rollout exists

## Context

Codex 0.167.0 creates a fresh session's rollout lazily. A separate read-only app-server has a different loaded-thread manager and cannot read the live TUI's thread before its first turn. Its queue API requires thread metadata before consulting durable queue storage. These failures do not establish empty history or queue.

## Decision

First-input recovery recognizes a separate `unmaterialized` state for the pinned platform contract. The observer preserves exact structured RPC errors and verifies the native version/account. The same native worker's open queue database establishes the configured SQLite root; successful read-only schema and exact-thread queue/goal observations establish no durable input or goal there. Missing, inaccessible or unsupported evidence remains unknown.

Only the original unsubmitted managed intent can combine this observation with a launch without initial input and a full rendered fresh welcome/empty Ready receiver. Prior submitted prompts, pending inputs, startup, foreign drafts and ambiguous views reject input. Runtime/process/thread/incarnation are fenced and observations repeated before the existing durable submission marker and before native mutation. A marker makes later reconciliation observation-only. No synthetic history, goal, packet, enforcement or start receipt is created.

The platform contract is pinned to OpenAI Codex `rust-v0.167.0`, commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`: rollout recorder's deferred materialization, thread processor's loaded-manager/persisted lookup, queue processor's thread prerequisite, independent queue schema and TUI input preview/startup/submission rendering. Ordinary stored-history observation and delivery/close remain unchanged. Other platform versions require their own established contract rather than an error-to-empty fallback.
