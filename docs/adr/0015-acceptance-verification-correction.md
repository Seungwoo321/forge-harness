# Audited acceptance verification correction

## Context

All active acceptance criteria use test coverage. A recorded external observation therefore requires a product test, while a delivery requirement can require evidence before the operation is permitted. Path amendments and delivery policy changes do not correct this recording mismatch.

## Decision

A public `unit acceptance correct` operation appends a revision-bound receipt for one exact active criterion on a submitted, unaccepted SelfGated unit. It preserves the entire original request, criteria, policy, evidence, findings and failure history. It records the original source digest, target, reason, verified user authorization and digest-bound provenance. The trusted provider must independently verify the original authority, a demonstrated recording mismatch, and the proposed observation or delivery classification. Product or mixed product requirements cannot be reclassified. Observation evidence requires a retrievable reference and byte digest verified against the target and current operational context. Unsupported verification fails closed.

Corrections are separate from criteria and never set covered, deferred or dropped. Acceptance and delivery reverify the current correction provenance and observation evidence. A new receipt can refresh observation evidence for a changed target; it cannot change a classification or delivery owner, or lower a delivery obligation. Exact command retries return the stored receipt. Stale requests, open stages, uncertain effects, forged evidence and unauthorized requests do not write.

Test coverage and the acceptance-coverage provider receive the product criteria projection, with the complete original obligations retained separately. The correction history binds that gate's fingerprint. Other required gates remain mandatory. Observations never enter test evidence. Review receives the correction audit through its handoff and must run after correction. Delivery obligations explicitly retain their original engine or external owner. Engine-owned obligations require the authorized policy and actual engine delivery level. External obligations preserve delivery:none and are verified through a trusted read-only provider at finish, terminal projection, close and finalization; missing or stale external evidence blocks completion, never product acceptance. The control plane appends target-bound external evidence receipts without fabricating engine effects. A same-tree external commit can bind the accepted SHA using the existing direct-parent/tree/content checks; other target changes require reacceptance. External ownership cannot be used to weaken an engine obligation, and policy changes cannot erase an external obligation.

## Consequences

Recovery stays on the original unit and acceptance remains a separate command. The source and verification provider are trust boundaries: an echo-only verifier or an unverifiable scanner is not sufficient evidence. No replacement unit, stored-record edits, fake passing test IDs, gate waiver or retry reset is part of recovery.
