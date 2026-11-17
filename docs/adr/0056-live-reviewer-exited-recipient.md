# Live historical reviewer with an exited original recipient

## Decision

`unit review-recipient-recover` recovers only an obsolete return transport whose registered, actually submitted historical reviewer remains live and whose exact original recipient has exited. It never changes the live process state. The separate native proof requires exact live sender identity/history and observed idle state, exact original destination absence/no-resume, original and current recovery authority, unchanged packets/records and actual current caller. Existing both-exited recovery remains strict and separate.

The transport fence is the immutable original destination identity plus shared original ledger/unit PID marker locks, not a stopped or fenced live sender. Actual legacy dispatchers must validate destination surface/process/incarnation before any input and reject unavailable/reused destinations. The public operation holds those original locks, target custody and goal OS lock while bracketing native checks and appending one audit. It cannot retarget, dispatch, complete or close the original transport/session.

Mode `exited-recipient-live-reviewer` permanently retires only the original delivery seq/key/digest. A live old dispatcher may append only its matching unknown/uncertain/not-applied unavailable-destination verification after the audit; validation preserves and checks every suffix row. New intent, submission, confirmation, result, completed observation, changed prefix/audit or foreign seq/key rejects settlement. Existing both-exited audit remains terminal. Current target review/gates/acceptance remain mandatory.

## Rationale

A live reviewer's idle screen alone is not a durable fence. Exact old destination absence prevents the legacy route from delivering even if the sender later observes it again. Shared original locks exclude an in-flight old finalizer while the immutable retirement audit is established. This represents actual endpoint states without fabricating an exit, suspension, delivery or closure.
