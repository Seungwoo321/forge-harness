---
name: implement
description: Implement the acceptance criteria from an opened implement StageInput.
---

# Implement

Read the StageInput file supplied by the unit driver and this directory's `contract.json`.

1. Use `data.acceptance`, `scopePaths`, `policy`, `canon`, `feedback`, and `assumptions` as the boundary. Read the affected code and callers, then make the smallest complete change within that boundary.
2. Preserve unrelated changes. Verify changed behavior with the project's relevant checks; propose evidence links in `coverage` as `{acceptanceRef,evidenceHint}`. A hint is not recorded passing gate evidence.
3. Return a separate StageOutput JSON matching `contract.json`: copy `inputDigest` and `attempt`, assign a stable `submissionId`, and include `status`, `summary`, `changedPaths`, `coverage`, `assumptions`, and `openDecisions`. Include `riskAssessment` when the profile requires it.
4. Resolve technical choices from the canon and existing conventions. Raise only unresolved product meaning, preference, external authority, or canonical conflicts in `openDecisions`.

The driver submits the output. Do not edit Unit Records, policy, checkpoints, gate evidence, failure counters, or effect ledgers. Do not declare acceptance or delivery from a successful local check.
