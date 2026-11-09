# Explicitly approved criterion exclusion

## Context

A user can remove a previously scoped behavior while its implementation unit is SelfGated. Decision resolution only reopens deferred work; scope amendments add paths, evidence corrections retain requirements, and goal amendments do not change unit criteria. The dropped status has no audited runtime writer.

## Decision

The public `unit acceptance drop` command excludes one exact active criterion on a submitted, unaccepted SelfGated unit. A revision, original criterion and source digests, current Git target, reason and digest-bound provenance identify the change. The trusted read-only provider verifies the actual user instruction and exact exclusion, separately from mere evidence-kind correction. Missing authority, an open stage, uncertain effects, stale targets or a conflicting retry cannot write.

The criterion retains its original id and text with status dropped. An append-only amendment stores the original source, before/after criterion and prior review. Policies, failures, retries, stages and evidence history remain intact. Gate evidence receives stale invalidations and all gate fingerprints bind the amendment epoch. Acceptance started before the amendment cannot commit afterward. Review submissions compare the input criteria and correction/amendment history before inspection and again under target custody, including separate review units; unchanged Git content cannot revive an old ship. Review is cleared and the existing policy governs fresh review. Older decision notifications and answers cannot reactivate a dropped criterion; pending decisions are not silently resolved.

Dropped criteria leave active product and operational/delivery verification; their correction history remains. Other corrections whose source changed require new public corrections and verification. A goal that still requires the excluded criterion cannot complete. The existing separately authorized goal amendment aligns the goal first; exclusion does not silently rewrite the goal or remaining criteria.

## Consequences

Recovery stays on the original unit, with an explicit user-authorized scope change rather than a fake passing test or weaker evidence classification. The provider contract stays generic. New requirements, arbitrary text replacement, policy relaxation, failure resets and automatic goal amendments are outside this operation.
