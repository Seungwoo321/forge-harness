# 0040: Preserve correction provenance across goal amendments

## Context

Goal amendments refresh the goal definition embedded in open units' requests. Acceptance corrections bind the entire original request, canon and acceptance by digest. Refreshing only goal metadata therefore invalidates an otherwise unchanged correction after product acceptance, where correction creation is deliberately unavailable.

## Decision

The authorized goal amendment path copies the goal's append-only amendment history, source binding and resulting objective and criteria into its open bound units. Correction verification uses that history only while the unit's current goal text equals the recorded result, and resolves an original source only when replacing objective and criteria produces the exact original source digest. Goal completion, which holds the goal record, also requires the goal id and source to equal the ledger and the history to be a prefix of the ledger whose following state is the recorded goal text. Closed units are not refreshed, so their history remains a valid prefix after later amendments. Every other request field, canon and acceptance remains current. New corrections bind the current source as before.

Original correction requests, authority references and receipts remain unchanged. Approval, correction provenance, Git target and external delivery are verified against the resolved original source at their existing boundaries. Product acceptance and independent review remain intact because neither their criteria nor their content changes.

An already amended unit receives the history through an authorized amendment to the current goal definition. This uses the same public command and preserves the original unit, acceptance, review, failures and delivery ownership. Unknown history or a change outside objective and criteria fails closed.

## Consequences

Goal completion and external delivery use the same correction-specific source resolution. Raw source reporting and new correction requests continue to describe the current request. This does not authorize requirement deletion, weaken delivery obligations or reuse external delivery observations without live verification.
