---
name: policy-setup
description: Set up, show, or change the work policy before a unit starts.
---

# Policy setup

Use this step when `policy resolve --json` returns `POLICY_UNSET`, when the user asks to change policy, or when the user asks to inspect the effective policy.

## Init

1. Run `policy detect --json` and treat its output only as clues. Never infer or write a goal class from repository contents.
2. Ask the user only through the configured provider's question tool, with at most four questions in one turn: goal class, save level, delivery cap, and whether to accept the class preset or adjust review/retry settings. Mark any clue-based suggestion as a recommendation.
3. Build a `PolicyDraft` JSON file and call `policy set --level <project|workspace|global> --draft <file>`. Workspace setup also supplies `--workspace-root`; global setup supplies the provider configuration root. The CLI owns validation, persistence, confirmation metadata, and source reporting.
4. Return the confirmed policy and field sources to the unit driver so it can resume the original unit.

## Change

Change only after an explicit user request. Ask for the intended values and a short reason, then call `policy set --change --reason <reason> --user-input-ref <confirmed-input-reference>` with the complete draft. The CLI records the prior policy and confirmation provenance.

## Show

Call `policy resolve --json` and present the resolved values with their field sources. Do not write anything.

## Non-interactive

Do not ask questions. Let `policy resolve --non-interactive --json` inherit configured policy or apply the conservative `task` default with `unconfirmed-default` provenance. Report that confirmation is pending for the next interactive session.
