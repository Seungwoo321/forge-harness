---
name: unit
description: Start or resume one work unit through the control plane.
---

# Unit driver

Resolve this skill's installed directory first. The package root is two directories above it. In the **user's project cwd**, call `node "<package-root>/scripts/unit.mjs" unit ...`; `unit` below is that full prefix, not a PATH executable. Keep the package root separate from the project/state roots. Pass the same explicit roots and `--adapters <module>` on later calls when supplied. Show the CLI output unchanged.

## Start

1. Run `unit start <unit> --request <file>` with the request file and policy roots for this unit.
2. If the result is `POLICY_UNSET`, load `policy-setup` in `init` mode. Use the configured provider question tool for its questions and let the policy CLI validate and save the confirmed draft.
3. After policy confirmation, rerun the exact same `unit start` command and request file. The CLI resolves policy and creates the Unit Record atomically; it does not infer `goal.class` from repository clues.
4. On success, open the `scope` stage with `unit stage open <unit> scope` and pass the resulting StageInput to the scope stage.

For managed continuity, first register the overall goal with `goal-register` and put its `goalId` in the unit request. Session startup and finish use the `session-start` and `session-finish` skills; a unit without a goal cannot finish under the new continuity contract. The request JSON contains `kind` and `request: {text, userInputRef}`; optional `canon` entries are `{path,digest}`. See the packaged `docs/getting-started.md` for a runnable first stage and adapter requirements. Do not fabricate a user-input reference or infer confirmation.

For non-interactive starts, pass `--non-interactive`. The CLI uses the configured policy or the conservative `task` default with `unconfirmed-default` provenance and does not load `policy-setup`.

## Review before delivery

When acceptance returns exit 20 (the unit is `InReview`), start the independent review first. Create the review unit with a request file `{"kind": "review", "targetUnit": "<unit>", "goalId": "<goal>", "request": {text, userInputRef}}` (`goalId` is required for a goal-managed target; without it the review unit is unbound and `session-start` refuses it), then run `session-start` for the reviewer. Only then create the PR or wait on remote CI, so the review and CI run in parallel.

## Resume

Use the Unit Record and effect ledger through the unit CLI. Do not recreate a unit with a different request under the same ID.

For a demonstrated mismatch that recorded an external observation or delivery obligation as a product gate criterion, use `unit acceptance correct <unit> --request <file> --user-input <ref>` on the original submitted SelfGated unit. Follow the packaged `docs/acceptance-recovery.md` for the exact request and trusted verifier contract. Preserve every original requirement and failed evidence; never invent passing test IDs. Unsupported user-input references or missing provenance/observation verification block correction. Refresh `unit progress` between corrections, then rerun acceptance and required independent review before delivery. Delivery corrections explicitly preserve the engine or external owner. For external ownership keep delivery:none; the trusted read-only verifyExternalDelivery provider must establish actual accepted-target-bound delivery before finish/finalization. Never enable engine delivery to satisfy an externally owned obligation. Do not patch installed copies or stored records.

If a command leaves the unit `Blocked`, keep this owning session active and do not write a terminal result. Supervise the bounded resolver path, wait for its completed root-cause submission, then run `unit resume` and continue at the returned original stage in this same session.

## Remote failure after acceptance

When a check outside the harness (remote CI, a deployment gate) fails after the unit was accepted and before it is delivered, do not fix it with a commit outside the unit. Run `scripts/unit.mjs unit reopen <unit> --request <file>` with `{"expectedRevision", "reason", "evidence"}` (evidence: the failing run's URL or log reference). The unit returns to Implementing with its acceptance cleared; open the implement stage, fix, and go through gates and independent review again. Widen the scope with `unit scope amend` if the fix touches paths outside it.

## Explicit user scope reduction

When the user explicitly removes a behavior, use `unit acceptance drop <unit> --request <file> --user-input <ref>` on the same submitted, unaccepted SelfGated unit. Follow the packaged `docs/criteria-changes.md` and require the trusted read-only `verifyAcceptanceChange` provider to verify the actual instruction. Keep original text/history, invalidate old gate evidence and review, align any goal through its separately authorized amendment, refresh remaining source-bound corrections, then reaccept and review under the existing policy. Do not simulate exclusion through a decision answer, evidence-kind correction, fake coverage, new unit or manual record edit.
