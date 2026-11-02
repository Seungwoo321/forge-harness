# ADR 0008: Review inputs and checkpoint restart

Date: 2026-10-29 · Scope: review preparation and interrupted stage opens

## Decision

The control plane prepares review inputs from the unit's first checkpoint, attributed changed paths, implementation summaries, coverage and gate evidence. The diff artifact contains the actual patch and has a byte digest. Acceptance records the inspected head and content fingerprint before requesting review. Review opening and submission verify the live target. Completed implementation attempts invalidate previously prepared review context.

Stage opening validates and durably saves StageInput before creating its checkpoint. Checkpoint commit messages bind the input digest. If record persistence is interrupted, reopening the same stage checks the pending input and reuses the existing ref only when its input, single parent, tree and producer identity match. It never deletes or overwrites an existing checkpoint.

The legacy unbound `review.1` case is limited to the original InReview unit with null diff/handoff, no recorded review attempt and a matching stored reviewDecision. A legacy record without top-level target fields takes them from that decision. The original producer message and identities, exact ref, single parent and current filtered tree must match. Review context is generated and validated normally; any pending input must also match. Missing bindings, foreign provenance or drift require investigation instead of guessed recovery.

## Consequences

Restart uses the existing stage-open command and preserves unit identity, prior attempts, acceptance, evidence and retry policy. The StageInput file is the durable preparation record; no second state machine or replacement unit is introduced. Unknown or conflicting refs remain intact. Legacy implementation summaries were not persisted; their handoff entries retain null summaries with original output digests, changed paths and coverage.
