---
name: root-cause
description: Diagnose a recorded failure using its failure-time StageInput snapshot.
---

# Root cause

Read the supplied StageInput and this directory's `contract.json`. The input contains failure-time `failures`, `evidence`, `changedPaths`, and `diff`; use that snapshot before consulting current referenced code.

1. Describe the symptom and reproduction, then trace the causal chain to the shared cause with file/line evidence. Distinguish immediate failure, the structure that permits it, and the design constraint behind that structure.
2. Classify each finding as `product`, `harness`, `environment`, or `user-domain`. Compare fixes at the local, shared-code, and design boundaries; recommend a fix that preserves the canon and addresses callers.
3. Return a separate StageOutput matching `contract.json`, copying `inputDigest` and `attempt` and assigning a stable `submissionId`. Supply `status`, `summary`, `findings`, and `assumptions`. A finding includes `id`, `kind: diagnosis`, `severity`, `site`, `claim`, `case`, `fix`, and its classification.

For a captured product gate at the retry limit, cite the specific failing evidence in the diagnosis and submit before editing. Use a `should-fix` diagnosis when the gate is the measure of repair. A `must-fix` remains subject to the usual independent finding resolution. On a successful submission, run `unit retry <unit> --cause-key <recorded-key>` to open the authorized correction, then use the normal implement and acceptance stages.

Do not patch code as part of diagnosis, change retry budgets, reset failure signatures, or write state/ledger/evidence files. The driver records the diagnosis and authorizes the bounded fix-forward path.

If evidence identifies a captured gate as a verifier or environment failure, submit that actual classification. Do not invent product repair. Use the verified classification correction in `docs/retry-recovery.md` through `unit retry --request`; the ordinary product repair command remains unavailable.
