# 0042: Validate initial goal bindings and audit same-unit clarification

## Context

Scope submission accepts acceptance criteria independently of the bound goal. Goal completion requires exact criterion text in an accepted unit. A wording mismatch can therefore survive implementation, gates and independent review and fail only at managed finish. Replacing the goal with narrower acceptance text discards obligations; reopening accepted product work merely to rename criteria destroys useful provenance.

## Decision

Initial scope validation checks the bound goal against the proposed acceptance and retained predecessor obligations before implementation proceeds. It uses exact text, never inferred semantic equivalence. Multi-unit goals retain obligations assigned to subsequent units; completing the last unit requires complete original goal coverage. Additional product acceptance remains enforceable.

A public same-unit clarification records an explicit complete mapping from unchanged original goal criteria to unchanged existing acceptance criteria. Each mapping includes content-addressed actual outcome evidence. The trusted provider verifies the original human authority, source provenance, every mapped obligation and actual external delivery, installation or original-command resumption, including requirements expressed only in the original goal. An acceptance criterion describing permission alone never proves execution. The engine rejects missing, duplicate, foreign, deferred, dropped or conflicting references. A product test is not evidence of external delivery.

Clarification binds the current unit and goal revisions and digests, source bytes, accepted target, acceptance, evidence, review, policy and native custody. It requires current accepted content and no unresolved effects or active stage/review operation. A retained Stopped-from-Accepted unit may record clarification without changing its stopped state, failure history or owner. Ordinary authorized resume remains separate.

The command serializes through existing ledger, unit and goal locks. It commits one append-only unit receipt and changes no goal, acceptance, gate, review, failure, retry or native ownership record. A crash before the atomic unit commit leaves no clarification; a crash after commit is recovered by exact replay. Reusing an identifier for a different request fails. Concurrent goal changes and target changes fail before commit.

Completion resolves an explicit mapping only through its intact source and accepted-obligation bindings. Live finalization revalidates trusted authority and external delivery through the existing boundaries. Goal completion still requires every original criterion and the ordinary accepted evidence and closed-unit checks. Clarification grants no publication, delivery execution or native termination authority.

## Retained live continuation

A retained recipient-free Stopped-from-Accepted owner cannot use the closed-owner resume path. An explicit clarification-bound goal resume requires separate source-backed same-owner continuation authority and proof that the original user-domain blocker is binding-only. It verifies original stop/failure packet bytes, exact current unit/goal/ledger/target/custody, settled reviews and repeated live native identity. It commits only an append-only goal continuation receipt and ordinary blocker history. The unit remains Stopped until ordinary unit resume revalidates that receipt and all unchanged accepted inputs. A stale gate or target fails without discarding acceptance. The same owner then finishes the original unit without a new session or fabricated closure. Ordinary closed-owner recovery remains unchanged.

The native serialization and command-specific dead-lock recovery cover both clarification and retained continuation. A crash before goal commit changes neither canonical record; a crash after it leaves a verifiable active-goal/Stopped-unit boundary. Exact replay completes that same boundary once. Unit resume uses the same audited request lock identity, preserving crash replay without removing foreign or legacy markers.

After a managed close has applied, clarification revalidation accepts only a current-plan-bound original close intent plus repeated trusted read-only proof of that exact owner closure. The scalar binding includes the normalized closure proof digest. Owner absence alone is insufficient. The existing effect ledger reconciles the real close; clarification writes no native receipt and never repeats the close to recover its response.

## Consequences

Exact initial bindings avoid late wording failures. Existing accepted units have an auditable recovery that preserves product and operational provenance. Semantic clarification requires a trusted read-only verifier; absent verification fails closed. Source changes, altered obligations, incompatible accepted content and fabricated evidence require diagnosis rather than guessed equivalence.
