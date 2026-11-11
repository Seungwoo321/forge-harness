---
name: policy-setup
description: Set up, show, or change the work policy before a unit starts.
---

# Policy setup

Resolve this skill's installed directory first; the package root is two directories above it. Run from the user's project cwd. `policy` below means `node "<package-root>/scripts/policy.mjs" policy`, not a PATH executable. Reuse the unit driver's explicit state/project/workspace/global roots. Show the CLI output unchanged.

Use this step when `policy resolve --json` returns `POLICY_UNSET`, when the user asks to change policy, or when the user asks to inspect the effective policy.

## Init

1. Run `policy detect --json` and treat its output only as clues. Never infer or write a goal class from repository contents.
2. Ask the user only through the configured provider's question tool, with at most four questions in one turn: goal class, save level, delivery cap, and whether to accept the class preset or adjust review/retry settings. Mark any clue-based suggestion as a recommendation.
   When configuring retry behavior, offer the default stop at the numeric limit and the explicit `retry.onExhaustion: root-cause` option. Explain that the latter keeps both numeric budgets and permits diagnosed, evidence-backed repair and verified same-unit recovery. Record it only on explicit selection.
3. Build a `PolicyDraft` JSON file and call `policy set --level <project|workspace|global> --draft <file>`. Workspace setup also supplies `--workspace-root`; global setup supplies the provider configuration root. The CLI owns validation, persistence, confirmation metadata, and source reporting.
   For `root-cause`, include `--user-input-ref <confirmed-input-reference>` when saving, including initial setup.
4. Return the confirmed policy and field sources to the unit driver so it can resume the original unit.

## Session execution

For managed goals, resolve `session.runtime`, `session.provider`, `session.account` (absolute provider configuration directory), `session.model`, `session.effort`, and the explicit executable `session.argv` from the user's existing policy and account configuration. Optional `session.roles` overrides those fields for `implementation`, `review`, `diagnosis`, or `resolver`. Preserve the approved permissions and account; do not assume a shell alias is available to a noninteractive process. Store no secret in policy. Ask only when an account or permission choice is genuinely unknown, and do not silently select another account.

## Change

Change only after an explicit user request. Ask for the intended values and a short reason, then call `policy set --change --reason <reason> --user-input-ref <confirmed-input-reference>` with the complete draft. The CLI records the prior policy and confirmation provenance.

For a submitted, undelivered unit, use the unit control plane's `unit policy change <unit> --request <file> --user-input <confirmed-input-reference>` instead. The request contains an id, the current expected revision, a reason, and exactly one of `delivery`, the complete `review` object, or `retry: {onExhaustion: "stop" | "root-cause"}`. Preserve the existing unit and re-run acceptance after the authorized change. A required independent review can resolve an applicability conflict without changing delivery.

## Show

Call `policy resolve --json` and present the resolved values with their field sources. Do not write anything.

## Non-interactive

Do not ask questions. Let `policy resolve --non-interactive --json` inherit configured policy or apply the conservative `task` default with `unconfirmed-default` provenance. Report that confirmation is pending for the next interactive session.
