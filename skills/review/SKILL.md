---
name: review
description: Independently review an opened review StageInput against acceptance and evidence.
---

# Review

Read only the driver-supplied StageInput and this directory's `contract.json` as work context, then inspect the referenced code, diff, handoff, and original evidence.

1. Work independently from the producer. Check acceptance coverage, behavior, failure boundaries, security, data integrity, and unnecessary complexity in the changed code and its callers.
2. Reuse passing evidence only when its input fingerprint matches the reviewed content. Do not turn producer claims or a summary into test evidence.
3. Return a separate StageOutput matching `contract.json`. Copy `inputDigest`, `attempt`, and input `head` into `reviewedHead`; assign a stable `submissionId`. Include `status`, `summary`, `findings`, and `verdict` (`ship` or `fix`).
4. Each finding supplies `id`, `kind`, `severity`, `site`, `claim`, `case`, and `fix`. An unresolved `must-fix` prevents `ship`. Give a concrete failing case and the smallest complete correction.

Do not modify product code or canonical state/evidence/ledger files. Submit through the driver; the control plane checks freshness and decides acceptance. For policy `review.by: user`, the driver uses the same output schema with `--by user`.
