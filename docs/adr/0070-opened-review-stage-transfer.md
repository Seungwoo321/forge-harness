# 0070 — Transfer a reviewer with an opened, unsubmitted review stage

The `suspendedReviews` and `exitedReviews` audits ([0051](0051-suspended-owner-handoff.md), [0052](0052-exited-worked-reviewer.md), [0069](0069-managed-owner-provider-transfer.md)) accepted only a reviewer with no stage at all. A worked reviewer normally opens its review StageInput before it does anything else. Its unit then holds one `review` attempt with `endedAt:null` and no output. The audit treated that attempt as submitted work and refused the transfer. The reviewer also could not submit, because it was unregistered. The unit had no public path forward.

An opened attempt is a control-plane input, not reviewer output. The audit accepts a reviewer whose stages are empty or hold exactly one `review` attempt with all of the following:

- no `endedAt`, `result`, `outputDigest` or `submissionId`;
- a StageInput file matching the recorded `inputDigest` and attempt number;
- a StageInput bound to the current target unit, head and content fingerprint.

Every other audit condition is unchanged. Ended, superseded, submitted or stale attempts are still refused.

The unit record and ledger stay byte-identical through handoff and recovery. The recovered reviewer submits the same opened attempt. Ordinary submission already requires that attempt to be open, its input to match the record, and the registered review custody and target to be current. No attempt is closed or rewritten on the reviewer's behalf, so the audit's unit digest pin and replay checks keep their meaning.

Closing the opened attempt as superseded during recovery was rejected. It would mutate a unit whose digest the handover audit pins. It would also break duplicate-replay comparison and add a record write to a path that only reserves the next session attempt.
