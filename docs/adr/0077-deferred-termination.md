# 0077 — Defer terminating signals while a state lock is held

Harness commands hold unit and ledger locks while they run. A caller wrapped `unit session-start` in `timeout 115`, and the `SIGTERM` that `timeout` sent ended Node immediately. The `finally` that removes the lock marker never ran, and two markers were left behind (`.lock`, `.ledger.lock`) with a dead PID. Every later write failed with `LEDGER_LOCK_ORPHANED` until an explicit lock recovery was run.

The public unit CLI installs handlers for `SIGTERM`, `SIGINT` and `SIGHUP`:

- With no state lock held, the signal is re-raised at once and the process ends as before.
- While a lock acquired through the state-lock guard (unit and ledger locks) is held, the signal is recorded and announced on stderr. When the last held lock is released it is re-raised, so the critical section completes and its marker is removed.

Ending between critical sections is the same boundary as a crash between operations, which the effect ledger already reconciles.

Releasing the lock early on the signal was rejected, because it could expose a half-written unit or ledger. An uncatchable kill still orphans the marker, and explicit `unit lock recover` remains the path for it. The session-start skill tells callers not to wrap harness commands in `timeout`, because those commands already bound their own waits.
