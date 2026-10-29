---
name: root-cause
description: Diagnose a recorded failure using its failure-time StageInput snapshot.
---

# Root cause

Read the supplied StageInput and this directory's `contract.json`. The input contains failure-time `failures`, `evidence`, `changedPaths`, and `diff`; use that snapshot before consulting current referenced code.

1. Describe the symptom and reproduction, then trace the causal chain to the shared cause with file/line evidence. Distinguish immediate failure, the structure that permits it, and the design constraint behind that structure.
2. Classify each finding as `product`, `harness`, `environment`, or `user-domain`. Compare fixes at the local, shared-code, and design boundaries; recommend a fix that preserves the canon and addresses callers.
3. Return a separate StageOutput matching `contract.json`, copying `inputDigest` and `attempt` and assigning a stable `submissionId`. Supply `status`, `summary`, `findings`, and `assumptions`. A finding includes `id`, `kind: diagnosis`, `severity`, `site`, `claim`, `case`, `fix`, and its classification.

Do not patch code as part of diagnosis, change retry budgets, reset failure signatures, or write state/ledger/evidence files. The driver records the diagnosis and authorizes the bounded fix-forward path.
