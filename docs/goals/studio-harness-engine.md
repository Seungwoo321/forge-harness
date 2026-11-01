# Goal: build the project-owned design-to-task workflow engine

## Goal prompt

Develop Forge Harness as an independently selectable deterministic work-engine plugin compatible with Studio Harness. Preserve the existing sequential, single-branch workflow and use the current Forge codebase as the implementation base. Treat each project's approved TO-BE design documents, architecture, policies and decisions as semantic canon. Support explicit authority/revision capture for those documents; decompose the canon into reviewable goals; link G/W/T behavioral scenarios beneath those goals; and create executable tasks linked to goals, scenarios or explicit non-behavioral acceptance, code scope and evidence.

Use a local SQLite database for task, goal, scenario relationship, session transition, attempt, decision, event and evidence-reference metadata. Keep canonical design documents as project-owned reviewable files and retain their source digests/revisions in the database. Generated Markdown prompts and reports are projections, not a second state authority. Do not require Git worktrees or parallel task ownership.

Enforce deterministic transitions through the Rust daemon/CLI and supported provider hooks. LLMs may author design/scenario/task proposals and perform implementation/review judgment, but cannot directly write authoritative state. Claude Code and Codex hooks call the public Forge contract at supported events. Workflow transitions request cmux/Orca launch, observation and exact-target cleanup through Studio Kit App's local session service when present; Forge owns task state and stores the returned App operation reference. The plugin declares its required App runner capability and refuses managed launch when it is unavailable; it never adds a competing cmux/Orca effect adapter. A completed task produces a machine-generated successor context and requests a fresh session. A technical blocker may use bounded resolver work; when resolved, the owning task resumes, completes, and then normal successor selection begins. Do not resume an already completed task session.

Studio Kit App's project profile is the sole plugin selection and approval authority. Forge consumes the ignored `.local/studio-kit/plugin-bindings.json` applied-deployment projection and verifies current App state, the complete project-local package digest, and callback event versions before invocation. Forge does not maintain a second plugin allow-list or approval setting. Selected-engine callbacks remain separate from provider-native hooks and their trust controls.

## Work sequence

1. Converge the canonical model, relations and ownership boundaries against `docs/spec.md` and ADRs. Inspect the in-progress worktree and preserve unrelated changes.
2. Specify SQLite schema, migration/recovery, event/evidence retention, and public CLI/API contracts.
3. Implement canonical source registration/snapshot, goal/scenario/task relations, and deterministic task state.
4. Implement provider hooks and runner adapters with idempotent launch/observe/prompt/close effects.
5. Integrate all three selected-engine callback events at their lifecycle boundaries with fail-closed App binding verification and transaction-time revision/fingerprint checks.
6. Add fresh-session handoff and bounded blocker-resolution lifecycle acceptance.
7. Run the complete Forge gates and record current evidence; do not accept stale, missing, skipped, pending or unverified evidence.

## Constraints

- Single branch, sequential task ownership; no worktree workflow.
- Canonical design documents precede goals; goals precede scenarios/tasks as applicable.
- G/W/T scenarios remain necessary behavior contracts but never the sole product canon.
- Preserve existing uncommitted work and source ownership.
- Rust daemon/CLI and SQLite own deterministic state. Node scripts remain thin provider hook/packaging adapters and never write SQLite directly.
- Keep this implementation task on the existing branch and checkout. Do not create parallel worktrees. The product workflow being implemented still uses a fresh session at completed task boundaries.
- Do not bypass provider hook trust. Report Codex plugin hooks as unenforced until the user trusts the current definition.
- Keep selected-engine callback capabilities unsupported until all three events have public lifecycle call sites, current App/receipt/package verification, isolated execution and transition-time stale-input checks.

## Initial next action

Read `docs/spec.md`, ADR 0012, the current dirty diff, and the Forge storage/session/provider adapter implementations. Reconcile the ADR against this goal, then write a versioned SQLite schema and migration acceptance contract before changing the existing JSON record store.
