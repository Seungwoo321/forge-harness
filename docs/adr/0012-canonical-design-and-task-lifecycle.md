# 0012: Canonical design and task lifecycle

## Status

Proposed — implementation target captured in [goal prompt](../goals/studio-harness-engine.md); reconcile against the active specification before acceptance.

## Context

Behavior scenarios are useful implementation and verification units, but they do not by themselves describe a complete product target. Projects may already own detailed TO-BE specifications, architecture documents, policies, and decisions. Treating scenarios as the only canon leaves design gaps and forces design work outside the task workflow.

The workflow also needs durable task, session, and verification history. Markdown handoff files can be generated for provider compatibility, but they are not the authoritative work state.

## Decision

The harness treats the target project's approved design documents as canonical inputs. It records their paths, content digests, authority relationships, and captured revisions, then links work goals, G/W/T scenarios, tasks, and verification evidence to those inputs. Design documents remain project-owned and reviewable in their existing format; the harness does not replace them with a second product specification.

Work goals divide the canonical target into reviewable outcomes. Scenarios describe observable behavior under those goals. Tasks are executable units linked to the relevant goals, scenarios, code scope, and evidence requirements. Chores that do not express product behavior may use task acceptance criteria without an invented scenario.

The work lifecycle remains sequential and single-checkout: one active task session owns the shared branch; a completed task starts a fresh session from a deterministic database-backed brief; the prior session closes only after the successor is observed accepting and starting work. A blocked task may use a bounded resolver session, after which the owning task session resumes.

The local database is the source of truth for task state, decisions, attempts, session transitions, raw structured events, and evidence references. Original design files and captured source snapshots remain authoritative design artifacts. Generated Markdown prompts or reports are projections and never replace their source records.

Claude Code and Codex use provider adapters over shared workflow contracts. cmux and Orca use runner adapters for session creation, observation, prompt delivery, acceptance, and exact-session closure. Hooks gate supported tool actions; scripts and the daemon own deterministic state transitions and runner effects.

## Consequences

- Scenario authoring follows canonical design and does not substitute for it.
- Canonical-source changes can invalidate dependent planning and verification evidence by digest.
- Session startup, handoff, recovery, and closure require durable identities and idempotent effect records.
- Provider hooks and runner APIs remain adapters; neither provider conversation history nor Markdown handoff files own task state.
- The implementation contract, schema, migration, and acceptance scenarios must define the local database and runner lifecycle before replacing the current record store.
