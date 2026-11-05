---
name: review
description: Independently review an opened review StageInput against acceptance and evidence.
---

# Review

A goal-managed review runs in a review unit created with `{"kind": "review", "targetUnit": "<unit>", "goalId": "<goal>", "request": {...}}`; start it as soon as the target reaches `InReview`, before PR creation or remote CI, and open its session with `session-start`.

Read only the driver-supplied StageInput and this directory's `contract.json` as work context, then inspect the referenced code, diff, handoff, and original evidence.

1. Work independently from the producer. Check acceptance coverage, behavior, failure boundaries, security, data integrity, and unnecessary complexity in the changed code and its callers.
2. Reuse passing evidence only when its input fingerprint matches the reviewed content. Do not turn producer claims or a summary into test evidence.
3. Return a separate StageOutput matching `contract.json`. Copy `inputDigest`, `attempt`, and input `head` into `reviewedHead`; assign a stable `submissionId`. Include `status`, `summary`, `findings`, and `verdict` (`ship` or `fix`).
4. Each finding supplies `id`, `kind`, `severity`, `site`, `claim`, `case`, and `fix`. An unresolved `must-fix` prevents `ship`. Give a concrete failing case and the smallest complete correction.
5. A ship verdict does not resolve historical findings. For repaired findings, preserve the original output and independent verification report for the public `unit finding resolve` command. Its trusted provider verifies reviewer independence, original finding provenance and evidence for every claimed fix; classification does not determine whether a repair is proven.

For a goal-managed independent review, submit from the registered review session, then use `session-return` to return the result and close that exact reviewer before the target proceeds. Do not modify product code or canonical state/evidence/ledger files. Submit through the driver; the control plane checks freshness and decides acceptance. For policy `review.by: user`, the driver uses the same output schema with `--by user`.
