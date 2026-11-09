# Current-base scope revalidation

## Context

An implementation can integrate approved upstream commits after its original checkpoint. The historical checkpoint delta then contains upstream paths as well as unit changes. Path-only scope revalidation cannot distinguish these sources, even when current gates and review cover the submitted target.

## Decision

Public scope recheck retains its existing path-authority check. For unresolved generated findings outside that authority, it can use the trusted Git provider's current base observation. The control plane verifies repository root, branch, HEAD, content tree, base reference and merge-base ancestry against Git and the submitted target. It independently computes the current unit delta and upstream delta from the original immutable checkpoint. A path is upstream-only only if it is absent from the current unit delta, present in the upstream delta, and untouched by unit-exclusive commits and recorded stage changes. Overlapping paths remain subject to unit scope.

The same unit and Git HEAD, branch and base-reference locks protect revalidation through its atomic update. A final observation rejects changes to source, base or provider metadata. The receipt preserves the original finding and digest and the exact attribution used. Scope, original checkpoints, completed outputs, changedPaths, failures, gate evidence and review remain unchanged. Revalidation grants no acceptance and never resolves reviewer-authored findings. Missing metadata cannot grant upstream exclusion.

## Consequences

Approved upstream-only historical findings can be resolved without broadening authority or rewriting evidence. Genuine drift, overlap, forged observations and stale current-target evidence fail closed. Ordinary path-only rechecks and checkpoint attribution remain compatible. Acceptance separately evaluates current gates and independent review.
