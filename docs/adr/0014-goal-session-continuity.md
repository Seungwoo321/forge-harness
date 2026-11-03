# ADR 0014: Goal-bound session continuity

## Context

A unit's acceptance is not proof that the user's overall objective is complete. Session startup must also preserve the chosen execution identity and the immutable goal and handoff context across both supported runtimes.

## Decision

A managed goal records the objective, completion criteria, outstanding work and execution policy. Pure decision functions validate the goal, derive the next transition and construct the successor prompt. Durable adapters own storage and the existing session adapter owns runtime effects and task receipts. A successful unit may transfer custody only after the exact successor starts and reads the bound packets. An unfinished or blocked goal cannot be reported as complete. Uncertain effects retain their original identifiers and are observed before retry. A blocker records a reason and resume condition without inventing a successor. User decisions and external authority remain outside automated resolution.

Execution policy specifies runtime, provider and account and selects model and effort from the current work policy at session start. It identifies the configured launch command without assuming shell aliases are available in noninteractive shells. The provider's native goal command or equivalent public goal API establishes the objective and carries the handoff and lifecycle requirements. The runtime separately verifies native goal activation, request submission and actual work start. A normal initial prompt or pasted text does not prove goal activation.

A session owns the agreed scope, not necessarily exactly one unit. Planning changes, implementation, verification and context compaction do not by themselves create a new session. Scope, authority or independent review responsibility changes require a verified transfer. Skills each wrap a single operation; deterministic decisions are not delegated to the model. Existing non-managed units require an explicit migration before managed continuation and retain their recorded history.

Unit completion within the same agreed session records the result and remaining goal without starting, delivering to, or closing a session. Actual custody transfer requires the exact recipient's native receipt and work start. Goal completion or a recipient-free stop durably records the outcome and, for a stop, its reason and resume condition; it does not invent a recipient or require a receipt. Only an explicitly closable managed worker may be closed, with its disappearance independently verified.

For Orca, the runtime discovers the client bundled with the installed CLI by default; an explicitly supplied `runtimeRpc` overrides it. The provider owns compatibility checks and the lifetime of any client it creates and disposes of it when finished. Missing or unsupported transport fails closed. This transport ownership supersedes the contrary transport-configuration statement in ADR 0005; its process identity and cwd fences remain in force.
