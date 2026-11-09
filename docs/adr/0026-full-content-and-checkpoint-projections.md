# Full-content evidence and checkpoint projections

## Context

Git scope recovery needs both the submitted content evidence and checkpoint attribution. A content provider includes tracked Git-ignored files unless policy explicitly excludes them. Checkpoints omit Git-ignored files, including tracked ones. Equal source and HEAD can therefore produce distinct legitimate content and checkpoint trees. Comparing these trees directly rejects valid recovery; comparing their deltas also conflates projection deletions with unit changes.

## Decision

Checkpoint inspection returns independently computed `contentTree`, existing checkpoint `tree`, and exact `excluded` paths. The content view contains tracked and non-ignored untracked files minus explicit policy exclusions. The checkpoint view additionally removes Git-ignored tracked files. Explicit policy exclusions are never staged into the content view; checkpoint creation retains its existing behavior.

Scope recheck compares the submitted full-content fingerprint to the independently computed current `contentTree`. It computes the provider's unit delta in that same content view. It records both content and checkpoint trees and the exact exclusions alongside the original finding receipt. Current full-content drift or a forged old full observation cannot be hidden by an unchanged checkpoint projection. Changing projection between the two locked observations also rejects recovery. No filename receives special authority and no historical output or evidence is rewritten.

## Consequences

Providers and checkpoint projections keep their distinct contracts. Generic tracked ignored files and explicit policy exclusions exercise the boundary. Actual-runtime validation preserves per-repository ignore rules and binds original unit bytes plus raw, full-content and checkpoint trees; a clone without that context cannot establish applicability. Acceptance remains separately responsible for current full-content gates and independent review.
