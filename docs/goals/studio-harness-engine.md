# Goal: build the project-owned design-to-task workflow engine

## Goal prompt

Develop Forge Harness as the deterministic work engine used by Studio Harness. Preserve the existing sequential, single-branch workflow and use the current Forge codebase as the implementation base. Treat each project's approved TO-BE design documents, architecture, policies and decisions as semantic canon. Support explicit authority/revision capture for those documents; decompose the canon into reviewable goals; link G/W/T behavioral scenarios beneath those goals; and create executable tasks linked to goals, scenarios or explicit non-behavioral acceptance, code scope and evidence.

Use a local SQLite database for task, goal, scenario relationship, session transition, attempt, decision, event and evidence-reference metadata. Keep canonical design documents as project-owned reviewable files and retain their source digests/revisions in the database. Generated Markdown prompts and reports are projections, not a second state authority. Do not require Git worktrees or parallel task ownership.

Enforce deterministic transitions through Forge scripts/daemon and supported provider hooks. LLMs may author design/scenario/task proposals and perform implementation/review judgment, but cannot directly write authoritative state. Add Claude Code and Codex hook/provider adapters plus cmux and Orca runner adapters for launch, observation, prompt injection and exact-target cleanup. A completed task produces a machine-generated successor context and starts a fresh session. A technical blocker may use bounded resolver work; when resolved, the owning task resumes, completes, and then normal successor selection begins. Do not resume an already completed task session.

## Work sequence

1. Converge the canonical model, relations and ownership boundaries against `docs/spec.md` and ADRs. Inspect the in-progress worktree and preserve unrelated changes.
2. Specify SQLite schema, migration/recovery, event/evidence retention, and public CLI/API contracts.
3. Implement canonical source registration/snapshot, goal/scenario/task relations, and deterministic task state.
4. Implement provider hooks and runner adapters with idempotent launch/observe/prompt/close effects.
5. Add fresh-session handoff and bounded blocker-resolution lifecycle acceptance.
6. Run the complete Forge gates and record current evidence; do not accept stale, missing, skipped, pending or unverified evidence.

## Constraints

- Single branch, sequential task ownership; no worktree workflow.
- Canonical design documents precede goals; goals precede scenarios/tasks as applicable.
- G/W/T scenarios remain necessary behavior contracts but never the sole product canon.
- Preserve existing uncommitted work and source ownership.
- Reuse Node scripts, shared provider-neutral skills and existing adapter boundaries. Introduce SQLite and daemon boundaries only with an explicit migration and recovery contract.
- Do not start another session or use context-handoff orchestration for this goal; continue in the current authorized session until its active work is complete.

## Initial next action

Read `docs/spec.md`, ADR 0012, the current dirty diff, and the Forge storage/session/provider adapter implementations. Reconcile the ADR against this goal, then write a versioned SQLite schema and migration acceptance contract before changing the existing JSON record store.
