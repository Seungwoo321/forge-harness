---
name: handoff
description: Draft the result and successor context from an opened handoff StageInput.
---

# Handoff

Read the supplied StageInput and this directory's `contract.json`.

1. Use `acceptance`, `changedPaths`, `evidence`, `assumptions`, and `next` to draft the result and remaining work. Link original evidence rather than copying logs. Preserve the approved successor and its boundary.
2. Return a separate StageOutput matching `contract.json`, copying `inputDigest` and `attempt`, assigning a stable `submissionId`, and supplying `status`, `summary`, and `handoff`.
3. In `handoff`, include the goal, acceptance, decisions, changed paths, verification references, remaining risks, and the next unit's first action. Distinguish completed work from unverified or externally blocked work.

Do not write result packets, Unit Records, or effect ledgers; do not launch or close sessions. The driver and registered session adapter own persistence, successor custody, actual launch/accept/start observation, and exact parent closure.
