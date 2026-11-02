# ADR 0011: Verified request submission and session finalization

Date: 2026-11-03 · Scope: session runtime and public finish

## Diagnosis

The terminal adapter verifies a process, but the finish flow interprets that observation as task acceptance. Initial command-line prompts, an idle composer, and a busy worker queue have different submission semantics. Return can leave a busy composer unchanged; queue insertion is not task start. The runtime also lacks a close effect and an existing-owner return path.

## Decision

The terminal and worker transports have separate responsibilities. Terminal observation fences session, process incarnation, and cwd. A configured worker transport observes the exact request and native execution activity, and submits through its supported interface. Pending interactive input requires a readiness fence and a conditional submit operation; arbitrary screen text never authorizes keystrokes. Native command-line prompts are observed without resubmission. Queue receipts remain pending until the exact request appears in an executing turn.

Task receipts bind the effect key, terminal incarnation, cwd, exact prompt digest, immutable packet references, native thread, request, turn, and execution item. Codex observation reads the native thread bound to the worker's open writer lock, using the installed protocol. Legacy initial requests require the exact original prompt and matching packet-read output; old ledger arguments are not rewritten.

`unit finish` also supports returning a result to an existing `returnTo` identity. It persists a finalization plan containing the observed owner, recipient, and immutable result/handoff. A surviving `unit finalize` process owns result delivery, the durable `session.close` intent, exact owner reobservation, native close, post-exit verification, and the final Closed transition. The public executable starts this process independently of the closing terminal. Uncertain delivery or close returns a pending status and preserves its intent. Retrying verifies the same effect and never blindly resubmits or recreates a session.

Only a runtime-configured closable worker is eligible for closure. The finalizer must survive outside that terminal; it never closes a recipient, an unrelated shell, or an orchestrator. Missing evidence, identity drift, failed close, and queued-only input cannot produce terminal success.

The return obligation is durable before tracker projection, so tracker recovery cannot bypass finalization. A legacy process-only result is independently reobserved and supplemented with native task evidence in the same ledger sequence; original rows remain intact. cmux refuses to close the last surface, and workspace closure has no atomic membership fence. The adapter therefore creates an exited placeholder when necessary and closes only the exact owner surface. It never closes a workspace or concurrently added surfaces.

## Consequences

Worker providers are explicit trusted runtime integrations, not agent-authored status files. Unsupported native versions fail closed. Source recovery preserves existing units, pending effects, and successors; official installation precedes resuming the original public command.
