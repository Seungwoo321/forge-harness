# 0044 — Refresh independently observed targets during mandatory revalidation

## Context

The existing resume path invalidates stale evidence and returns submitted units to SelfGated. It retains the old submitted head and content fingerprint. Existing-owner adoption then rejects a changed working target, while a red mandatory gate prevents ordinary acceptance from refreshing that target. This leaves the original unit unable to obtain verified custody before repairing its gates.

## Decision

The public resume driver supplies its trusted Git inspector to the existing resume helper. During executable revalidation the helper independently observes the current complete target, checks the supplied snapshot against it, and repeats the observation before committing. It records the previous and current target in the existing revalidation audit row and refreshes the unit target. Changed targets invalidate all latest gate evidence, acceptance and review; diff and handoff are cleared for fresh review preparation.

This transition grants no gate coverage or acceptance and still requires normal mandatory gates and independent review. Existing effect, checkpoint, tracker, stopped-owner, authority and revision checks remain intact. A missing trusted inspector does not authorize a target change. Failed or drifting observations leave the unit unchanged. Native adoption retains its target equality check.
