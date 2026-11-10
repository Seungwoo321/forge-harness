# Retained continuation and incoming review boundaries

Status: Accepted

## Context

A delivered continuation preserves its predecessor and historical finalization, advances the goal cursor and registers the existing owner on the successor. A Stop guard that follows only ordinary same-session transfers continues guarding the predecessor. An owner waiting for a queued independent review return can also keep its current turn active when the guard requires work before permitting the boundary that receives that return.

## Decision

The Stop guard follows a delivered continuation only when the retained predecessor digest, transfer/adoption request, successor goal and existing native owner agree. Invalid or cyclic chains remain guarded.

A current owner may yield its turn for an incoming review return with an exact goal/target/recipient binding, unchanged immutable packets and one matching original native-queue intent, submission and confirmation. A retired or completed delivery does not grant this exception. This is permission to reach a native input boundary, not evidence of receipt, unit completion or owner closure. The existing delivery observer and finalizer still require the original native request and actual result read before closing only the reviewer.

The guard reads existing records and ledgers. It does not submit, consume, resume, cancel or duplicate native input, change goal state, or write custody/evidence. Normal host dispatch consumes the existing queued request.

## Consequences

The retained owner can receive its existing review without finishing a historical predecessor or loading its live thread in another manager. Unconfirmed, stale, malformed or changed inputs preserve the ordinary unfinished-work guard.
