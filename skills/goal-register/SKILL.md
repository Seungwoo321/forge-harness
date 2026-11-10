---
name: goal-register
description: Register the overall goal and bind it to the resolved execution policy.
---

# Register a goal

Use the installed package's `scripts/unit.mjs` in the project cwd. Prepare a JSON request with `goal` (`id`, `objective`, `criteria`, `remaining`, `status: active`) and `source` (absolute path and SHA-256 digest of the user-authorized goal document). Work policy supplies `session.runtime`, `provider`, `account`, `model`, `effort`, and `argv`; do not invent them or store secrets in policy. Use `goal create <id> --request <file>` with the same policy roots used for units. Verify with `goal show <id>`. List approved units in execution order and bind each through `goalId` in its start request. Add later approved work using `goal-add-work`. Do not modify goal state files directly.

When the user approves a work-policy change that affects an active goal's execution policy (for example a review role), apply it with `goal policy-refresh <id> --request <file> --user-input <ref> --adapters <module>`. The request holds `expectedRevision` and `reason`; the trusted provider verifies the exact authorization. Units started afterwards bind to the refreshed policy; do not recreate the goal.

For an already applied refresh with incorrect authority, follow `docs/policy-refresh-recovery.md` and public `goal policy-recover` with exact current bindings and a trusted original-authority/native-execution verifier. Restore only the last refresh's independently authorized previous policy, preserve the erroneous row and all history, and append the audited recovery. A relay reference or message presence is insufficient. Do not change shared policy or repeat an obsolete revision. Empty session role maps and omitted role maps compare neutrally without rewriting persisted policy.
