---
name: unit
description: Start or resume one work unit through the control plane.
---

# Unit driver

## Start

1. Run `unit start <unit> --request <file>` with the request file and policy roots for this unit.
2. If the result is `POLICY_UNSET`, load `policy-setup` in `init` mode. Use the configured provider question tool for its questions and let the policy CLI validate and save the confirmed draft.
3. After policy confirmation, rerun the exact same `unit start` command and request file. The CLI resolves policy and creates the Unit Record atomically; it does not infer `goal.class` from repository clues.
4. On success, open the `scope` stage with `unit stage open <unit> scope` and pass the resulting StageInput to the scope stage.

For non-interactive starts, pass `--non-interactive`. The CLI uses the configured policy or the conservative `task` default with `unconfirmed-default` provenance and does not load `policy-setup`.

## Resume

Use the Unit Record and effect ledger through the unit CLI. Do not recreate a unit with a different request under the same ID.

If a command leaves the unit `Blocked`, keep this owning session active and do not write a terminal result. Supervise the bounded resolver path, wait for its completed root-cause submission, then run `unit resume` and continue at the returned original stage in this same session.
