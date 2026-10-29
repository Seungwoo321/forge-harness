---
name: gates
description: Run configured deterministic gates and acceptance through the unit control plane.
---

# Gates driver

Resolve the package root two directories above this installed skill. From the user's project cwd, run `node "<package-root>/scripts/unit.mjs" unit accept <unit> --adapters <module>` with the current unit's roots and runtime module, and show the result unchanged.

This invokes the configured gate providers, records fingerprinted evidence, and evaluates acceptance and review policy. `gates` is a control-plane stage: never open it with `unit stage open` or generate an LLM StageOutput for it. Exit 20 means independent review is required; follow the returned state and the unit driver.

For a requested independent evidence rerun, use the same executable and options with `evidence rerun <unit> --gate <id>`. Never write passing evidence yourself. Missing providers are configuration failures, not a passing gate.
