# 0069 — Provider transfer from a managed bootstrap owner

A unit started by `unit session-start` is owned by its managed bootstrap. The bootstrap records the launched session identity and its immutable launch snapshot. It records no native process owner and no policy digest. `goal policy-refresh` changes only later launches. Public handoff and reassignment accepted only an existing-session predecessor. The only remaining route recorded a false product failure and required settled reviewers.

The public `unit session-handoff` and `unit session-reassign` transitions also accept the unit's current managed bootstrap as the predecessor. The request then names the exact old native owner in `previousOwner`. Core proves that identity from the bootstrap and its original `session.start` intent and result. Every recorded submission, receiver and confirmation binding must agree, and so must the provider of the immutable launch snapshot. A caller's copied identity is not authority.

The next execution policy is the current goal policy, which `goal policy-refresh` has already set. The handover does not choose or change policy. Existing-session handoffs keep their own policy selection. The suspension or exit fence, user authority, verifier contract, source, target and ledger checks are unchanged. Managed requests add `previousOwnership:'managed'` and `previousOwnerDigest` to the verifier binding. Requests without `previousOwner` keep their previous bindings.

A reviewer launched by a managed target owner never bound the target digest. The existing `suspendedReviews` and `exitedReviews` audits accept that reviewer and pin the current target digest. Startup recovery adds that pinned digest to the next attempt's arguments. The fresh attempt then follows the ordinary existing-owner review start. No verdict, failure, non-start, ledger edit or intent replacement is produced.

Managed successors started by a finish transfer stay outside this transition. Their transfer receipt has no launch snapshot path to prove the original policy.
