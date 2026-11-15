# 0043 — Bind submitted unaccepted units without completing their review

## Context

The Accepted-only recovery leaves an unbound InReview unit unable to start managed independent review: review requires goal custody, while recovering the missing goal requires completed review. Resetting the unit would erase its existing failure and authority history.

## Decision

The same explicit missing-binding recovery also permits SelfGated and InReview change units with no acceptance snapshot and completed scope and implement attempts. It retains the exact state, gate evidence, failures and pending review. Accepted units retain their existing target, gate and independent review checks. Every state retains the same exact digest, source-backed permission, immutable source, live target, unresolved-effect and goal-lock checks.

Binding only appends goal metadata and its audit receipt. Normal custody adoption, gate revalidation and independent review remain mandatory before acceptance or delivery. It creates no native start receipt or ownership.
