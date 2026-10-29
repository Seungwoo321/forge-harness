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

The request JSON contains `kind` and `request: {text, userInputRef}`; optional `canon` entries are `{path,digest}`. See the packaged `docs/getting-started.md` for a runnable first stage and adapter requirements. Do not fabricate a user-input reference or infer confirmation.

For non-interactive starts, pass `--non-interactive`. The CLI uses the configured policy or the conservative `task` default with `unconfirmed-default` provenance and does not load `policy-setup`.

## Resume

Use the Unit Record and effect ledger through the unit CLI. Do not recreate a unit with a different request under the same ID.

If a command leaves the unit `Blocked`, keep this owning session active and do not write a terminal result. Supervise the bounded resolver path, wait for its completed root-cause submission, then run `unit resume` and continue at the returned original stage in this same session.
