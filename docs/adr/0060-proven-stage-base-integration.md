# 0060 — Proven stage base integration during scope recovery

## Decision

A submitted stage path is not automatically authored by the unit: opening implementation before a clean upstream merge includes inherited paths in the checkpoint delta. Scope recheck may account for that exact terminal stage integration using immutable checkpoint objects and the real two-parent clean merge tree. It preserves the original stage, finding and current evidence, and records the attribution separately. Actual unit-exclusive commits, including reverted changes and merge conflict resolutions, remain subject to scope.

After delivery merges the feature into its approved target, recheck finds the first first-parent target merge that introduces the current unit HEAD and uses its first parent to recover the pre-delivery comparison base. Fast-forward or ambiguous introductions fail closed. Current provider base observations are still checked against Git independently; the comparison base is derived from ancestry, never supplied by a request.

Only recorded paths of the latest completed attempt whose checkpoint HEAD is the merge's first parent may be discounted. The second parent must be approved upstream, the whole current tree must equal the conflict-free automatic merge result, and each discounted path must be unchanged in the immutable checkpoint relative to its parent, inherited by that merge and absent from unit-exclusive committed history. Older, unbound, conflicting, edited or uncommitted targets retain their recorded paths. This resolves current scope attribution without claiming that unrecorded historical edits never occurred or erasing any audit evidence.
