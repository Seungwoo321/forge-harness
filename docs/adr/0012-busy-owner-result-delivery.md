# ADR 0012: Primary-thread identity and busy-owner delivery

Date: 2026-11-03 · Follow-up to ADR 0011

Actual return to an existing owner exposed two gaps: one Codex host retains writer locks for completed collaboration subagents, and a next-turn queue can wait indefinitely while the owner supervises its repair. Native metadata identifies the unique owned `cli` or `exec` thread with the expected cwd; child threads are never selected by lock order.

For cmux Codex result delivery, the runtime uses the live TUI's ordinary submission/steering path. It verifies an empty recognized composer, pastes a short immutable packet reference, observes the exact settled composer, rechecks worker/thread identity, and sends Return separately. A changed draft, modal, unsupported screen or ambiguous identity fails closed. Significant whitespace is preserved; wrapped composer text is rejected because a text snapshot cannot reconstruct removed wrap spaces. The reference prompt is compact enough to fit the observed supported layout. Terminal acknowledgments are not delivery evidence: exact native user input and subsequent packet-read/activity evidence remain mandatory. Existing queued inputs are neither removed nor replayed.

Authoritative absence from native history and queue together with the exact pending composer permits a bounded retry on the same delivery intent. The pending composer is resumed without pasting again; an empty composer alone does not prove a failed submission. Receipt uncertainty never authorizes duplicate submission. Installed recovery and actual busy-parent consumption are acceptance conditions for this follow-up.
