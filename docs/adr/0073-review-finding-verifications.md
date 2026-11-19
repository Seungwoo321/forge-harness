# 0073 — Per-finding verifications in the review output

`unit finding resolve` needs the independent reviewer's claim that each repaired finding is fixed. The review skill only asked reviewers to "preserve an independent verification report", with no format, location or binding. A reviewer that followed the skill submitted `ship` and a summary, and hosts could not verify per-finding claims without a side file in their own format.

When a review StageInput is opened, the control plane adds the target's unresolved findings as `priorFindings: [{index, digest, finding}]`. This is a top-level input field, because `data` mirrors the contract reads exactly. The review StageOutput may carry `findingVerifications: [{index, digest, verified, case, evidence}]`.

At submission, every entry must reference a distinct prior finding of that input by exact index and digest, with a nonblank case and evidence. The entries are therefore bound by the submitted output digest.

If the ship review's output carries `findingVerifications`, `unit finding resolve` requires a `verified: true` entry for every requested finding. A host verifier reads the claims from that immutable output. Outputs without the field keep the previous evidence-file contract. The field does not change acceptance by itself: a ship verdict still does not resolve historical findings without the public resolution.
