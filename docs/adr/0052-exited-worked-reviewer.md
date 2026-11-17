# 0052 — Preserve worked review history after an observed reviewer exit

A reviewer can perform real native work and still lack its complete startup receipt. If it independently exits before the authorized owner transfer, neither suspension nor terminal non-start is true. Its unresolved startup and informal work must stay observable without inventing closure or a verdict.

The existing public owner transfer accepts a separate optional `exitedReviews` inventory, disjoint from suspendedReviews. The same locked unit/ledger/intent/submission/source/target bindings apply. A distinct native absence observation must fence the exact original reviewer before and after the replacement caller observation. The audit records ownerState exited and has its own digest, without changing either original record or ledger.

Public session-recover selects verifyExitedReviewRecovery only for that exact exited audit. It requires real continuation authority, original native history/account and exclusive current execution proof, returns receiverExited rather than receiverSuspended, and rejects taskNeverStarted. The next-attempt reservation uses exited-handoff mode and normal startup/review/return contracts. Resumed processes, ambiguous absence, false suspension/non-start, duplicate inventories and changed source/target/ledger reject before mutation.

Requests and callbacks without exitedReviews keep their existing bindings. Suspension and non-start recovery retain their original conditions. No installed cache or stored record is patched to reach this transition.
