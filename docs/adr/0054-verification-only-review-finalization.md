# Verification-only finalization of original closed reviews

## Decision

`unit finalize <review> --reconcile-only` reconciles an existing Closed review's original close intent without observing a live recipient or executing any external effect. It requires the original finalization plan, unchanged immutable packets, an exact positive recorded delivery receipt and the original exact close intent. It refuses other unit kinds, retained user owners and successor starts.

The normal effect engine records the original close result only from a fresh official native close verification. A second native observation must still verify the exact original session/incarnation before the normal finalization receipt is stored. Ledger-before-unit locks and a full record compare-and-set preserve the original plan, recipient custody and history. Unknown and not-applied observations remain pending; no new intent, delivery, retry execution or close is permitted.

## Rationale

A review can have delivered its result and submitted its verdict before its final close response is lost. If the original recipient later exits, requiring a live recipient before recording the already completed original close prevents recovery. A validated original positive delivery receipt remains evidence; the Closed state and process absence are not receipts. Verification-only reconciliation preserves native close proofs and leaves normal execution/custody checks unchanged.
