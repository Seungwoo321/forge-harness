# Active recipient result delivery

An interactive recipient can stay in a working turn while its reviewer's finalizer waits for result delivery. A screen composer is not a safe input target while the turn is active, and waiting for an idle composer can deadlock with an automatic continuation hook.

A separate native history observer can report an interrupted turn while its owning process is still working. For a Codex recipient whose native history confirms an active turn or whose verified terminal has the supported Working status footer, result delivery uses the native thread queue. Terminal state selects the input route; native identity, request and packet observations remain mandatory. The existing immutable intent, recipient process and thread, route, effect-keyed prompt, and packet digests bind the durable submission and confirmation checkpoints. The thread, absence of the same request, and packet integrity are checked at both boundaries. After confirmation, uncertain or consumed submissions are observed only; a queued message is not a receipt. Completion still requires the exact native request, subsequent activity and the immutable result packet read before reviewer closure.

An idle recipient retains the existing composer protocol, including foreign-draft and pending-input protection. Missing or ambiguous native state fails closed.

A queue-route submission checkpoint records no native mutation. If confirmation was not consumed, recovery may verify that the identical keyed request is absent and confirm it without recording another submission. An ambiguous older unbound prompt remains observation-only; it cannot prove a different effect or authorize a duplicate. Once confirmation is consumed, retries are observation-only.
