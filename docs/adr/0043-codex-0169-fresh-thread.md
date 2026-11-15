# 0043 — Codex 0.169.0 fresh-thread observation

## Context

The exact platform fences reject a fresh Codex 0.169.0 receiver before its independent storage and native-view checks run. Its missing rollout is not evidence of empty history.

The OpenAI [0.168.0 → 0.169.0 comparison](https://github.com/openai/codex/compare/rust-v0.168.0...rust-v0.169.0) preserves the thread-read state processor, goal processor, goal runtime and migrations, queue runtime schema, goal menu and hook-list tests. The [queue processor](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs) adds client metadata to enqueue/update responses, outside the unloaded-thread queue-list error path. The [recorder](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/rollout/src/recorder.rs) changes attached-thread listing and reconciliation, retaining deferred rollout creation. The [input flow](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/chatwidget/input_flow.rs) records direct Enter provenance and normalizes queued provenance; it retains direct submission and separate queued input. Composer changes concern skill-completion punctuation, pending backend handoff and footer rendering. They preserve plain `/goal` typing and separate Return submission on the recognized empty Ready view.

## Decision

The observer, task transport, durable-submission validator and composer admit exactly Codex 0.169.0 alongside 0.167.0, 0.167.1 and 0.168.0. Each boundary retains its own validation. The proof records the actual version and requires its matching complete native welcome. Account, PID/thread ownership, structured errors, supported owned queue/goal storage, empty per-thread state, trusted hooks and original no-input launch remain mandatory.

Existing startup intents reconcile on their original receiver through the public command. A source runtime adapter can exercise the correction before publication; that does not constitute installation. Unknown patches, custom suffixes, mismatched welcome views and ambiguous native observations remain rejected. Durable submission and observation-only recovery after an uncertain mutation retain their existing semantics.

## Consequences

Exact 0.169.0 positive coverage spans native observation, durable first-input recovery and composer submission. Negative coverage retains unsupported/custom platforms, mismatched welcomes, queued input, changed identity and unsupported schemas. No native history is synthesized and no upstream application or operating-system change is required.
