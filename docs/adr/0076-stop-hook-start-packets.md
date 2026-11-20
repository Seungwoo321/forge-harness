# 0076 — The Stop hook names unread start packets

A Claude managed start is verified from the session's own reads of its immutable packets after the `/goal` command: the handoff, any result, and the goal snapshot. Models repeatedly skipped the goal snapshot, read it with a shell before `/goal`, or never read it. The start then stayed `SESSION_TASK_UNVERIFIED` until an operator asked the session to read it.

The goal text cannot change for this purpose. Existing start intents recompute it to match the native goal, so rewording it would break in-flight units.

The managed Stop hook already runs in every managed session, so it now also checks the start. It finds the latest unresolved `session.start` intent for its unit in any unit ledger, because successor starts are recorded by their predecessor. That intent's submission thread must equal the hook's `session_id`, and its execution policy must be Claude. The hook then reads the transcript after the last `/goal` command, using the same proof the receipt uses:

- an exact numbered Read result;
- or a non-error shell result that names the path and contains the packet's full content.

Every packet without such a read is named, and the hook blocks the stop with an instruction to read it in full with the Read tool. When `stop_hook_active` is set, the hook only informs. After the receipt is recorded, or for another session or another provider, the hook does not intervene, and its existing goal handoff guidance applies unchanged.
