---
name: gates
description: Run configured deterministic gates and acceptance through the unit control plane.
---

# Gates driver

Resolve the package root two directories above this installed skill. From the user's project cwd, run `node "<package-root>/scripts/unit.mjs" unit accept <unit> --adapters <module>` with the current unit's roots and runtime module, and show the result unchanged.

The gate provider describes the exact commands, inputs and output directories; the control plane executes commands in isolated snapshots, records fingerprinted evidence, and evaluates acceptance and review policy. `gates` is a control-plane stage: never open it with `unit stage open` or generate an LLM StageOutput for it. Exit 20 means independent review is required; follow the returned state and the unit driver. If a provider cannot supply complete snapshot inputs or the isolation backend is unavailable, repair its configuration rather than treating a live-tree result as passing.

For a requested independent evidence rerun, use the same executable and options with `evidence rerun <unit> --gate <id>`. Never write passing evidence yourself. Missing providers are configuration failures, not a passing gate.

Verified acceptance corrections retain all obligations while projecting only product criteria to acceptance-coverage. External observations require current trusted verification and never count as tests; delivery obligations preserve their engine or external owner. Externally owned PRs are verified after acceptance at finish/finalization through trusted read-only evidence while delivery:none stays unchanged. A static scanner that ignores the supplied projection or selects paths from another target must be repaired at its provider boundary. Missing product evidence remains a failure. See the packaged `docs/acceptance-recovery.md`.
