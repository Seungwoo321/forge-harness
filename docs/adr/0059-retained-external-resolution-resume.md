# 0059 — Retained owner continuation after external resolution

## Decision

A retained live implementation owner stopped from Accepted may resume after its recorded external user-domain/defer blocker is actually resolved. This is distinct from binding-only clarification and closed-owner recovery. The public goal resume request explicitly selects external resolution and binds the original source, current unit/goal/ledger/target/custody and resolution evidence. Independent trusted input and semantic resolution providers must verify the original human continuation authority, exact blocker and real resolution; an operational relay is not authority.

Goal resume only activates the original goal and appends an audited receipt. Unit resume rechecks the same evidence, native custody and target under existing locks, then reopens the original implementation stage for dependency integration, followed by ordinary gate revalidation and policy-required review. Prior acceptance, review, failures, stop packets and custody remain in history. It never creates a session, closes an owner, changes a base or synthesizes delivery evidence.

## Consequences

The existing binding-only and verified closed-owner contracts remain unchanged. Unsettled effects/reviews, reservations, changed or ambiguous owners, stale inputs, invalid evidence, product retry failures and delivery/finalization plans fail closed. Replaying an identical request after a goal commit revalidates and returns the same receipt. Different requests cannot reuse its identity.
