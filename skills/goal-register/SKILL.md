---
name: goal-register
description: Register the overall goal and bind it to the resolved execution policy.
---

# Register a goal

Use the installed package's `scripts/unit.mjs` in the project cwd. Prepare a JSON request with `goal` (`id`, `objective`, `criteria`, `remaining`, `status: active`) and `source` (absolute path and SHA-256 digest of the user-authorized goal document). Work policy supplies `session.runtime`, `provider`, `account`, `model`, `effort`, and `argv`; do not invent them or store secrets in policy. Use `goal create <id> --request <file>` with the same policy roots used for units. Verify with `goal show <id>`. List approved units in execution order and bind each through `goalId` in its start request. Add later approved work using `goal-add-work`. Do not modify goal state files directly.
