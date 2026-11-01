# ADR 0012: Canonical design and sequential task lifecycle

## Status

Accepted. This decision is reflected in `docs/spec.md` §14 and supersedes the earlier JSON-file state and worktree-isolation decisions.

## Context

G/W/T scenarios are necessary for observable behavioral acceptance, but they do not by themselves describe a complete product target. Product teams own richer TO-BE design documents, architecture, policies and decisions. The development workflow must preserve these documents as semantic canon while connecting them to actionable goals, scenarios and tasks. The prior JSON Unit Record model also needs durable queryable relationships and session/evidence history without a second Markdown state authority.

## Decision

Approved project design documents remain project-owned files and the semantic source of truth. Forge records each source's path, authority, digest and captured revision. Design work produces or updates those documents first. Reviewable goals divide the approved target. G/W/T scenarios describe observable behavior under goals. Executable tasks link to goals, relevant scenarios, code scope and evidence requirements. Non-behavioral work can carry explicit task acceptance without a fabricated scenario. Unresolved product meaning remains an explicit decision blocker.

Forge stores structured work state in one project-local SQLite database at `.local/forge/forge.sqlite3`. Rust CLI/daemon services own database access, transactional state transitions, migrations, constraints, idempotency and append-only event/effect/evidence history. Provider hooks and scripts are thin adapters that call the public CLI/daemon contract; they do not write the database or duplicate transition logic. LLM roles author proposals, implementation and independent review but cannot directly mutate authoritative state. Existing JSON Unit Records are imported through a versioned, loss-checked migration; source records are retained until post-migration identity and evidence reconciliation succeeds.

Work remains sequential in one checkout and one branch. Forge admits one active task owner/session at a time and does not create or schedule parallel Git worktrees. A completed task produces a successor request from current database state. The local Studio Kit App session service is the sole owner of cmux/Orca launch, observation and close effects; Forge stores the task-to-session association and App operation reference. A bounded technical resolver may run while its parent task is blocked; once resolved, the parent task session resumes. After the parent task completes, successor selection starts the next task in a fresh session. User decisions, authentication, quota, access and external approvals are reported as blockers without an automated resolver session.

Claude Code and Codex provider hooks call the public Forge service at supported lifecycle/tool boundaries. Hooks are enforcement only after the host activates them. Codex unmanaged hook definitions require user review and trust; Forge and Studio Kit App never bypass this host gate. If required hook trust or runner capability is not established, startup reports the workflow as unenforced and blocks the selected managed start.

## Consequences

- Design documents precede goals; goals precede applicable scenarios and executable tasks.
- Scenario coverage cannot substitute for completeness of product design.
- SQLite is the single authority for structured task/session/evidence state; generated Markdown and JSON are exchange/projection formats.
- Transactional migrations preserve prior JSON records and original evidence references without parallel writers.
- Single-branch ownership removes worktree isolation policy and concurrent-task path attribution.
- Forge owns work lifecycle; Studio Kit App owns generic runner effects; Gate Kernel or the selected verifier owns original verdicts.
- Provider trust and actual hook discovery are observable preconditions, never prompt-only claims.
