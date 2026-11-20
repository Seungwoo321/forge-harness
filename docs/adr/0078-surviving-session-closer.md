# 0078 — Only a surviving process closes an owner session

A unit finished by a goal session hands the result to the recipient and then closes the owner session (`session.close`). The owner agent ran `unit finalize` from its own session, as the session-finish skill tells it to do for a pending outcome. That finalize delivered the result, recorded the `session.close` intent and its submission, and closed the owner workspace. Closing the workspace ended the owner agent and the finalize process with it, while the process still held the unit lock (taken by the goal close fence) and the ledger lock (taken by the effect ledger). The ledger kept `intent` and `submission` without a `result`, and `.lock` and `.ledger.lock` stayed behind with the dead PID, so every later command failed until an explicit lock recovery.

The specification already requires that a separate surviving process close the owner (H-DL-09). The session runner enforced it by comparing the caller's terminal with the owner's terminal. Agent tool commands run without a controlling terminal, so the caller looked external although it was a descendant of the owner worker and ended with it. Deferring signals (ADR 0077) does not help: the owner can end with an uncatchable kill, and even a deferred signal cannot return a result from a process whose host is gone.

## Decision

- The session runner decides survival by process ancestry. It walks the caller's ancestors from one complete process inventory (`pid`, `ppid`, terminal). A caller is inside the owner when any ancestor, itself included, is the owner process, the owner worker, or attached to the owner's terminal. An incomplete inventory fails closed.
- The check runs as a session `preflight` for `session.close`, before the close intent. `finalize` returns pending with `externalFinalizerRequired: true` and records nothing. The same check still guards execution and verification inside the runner.
- A plain `unit finalize` (no `--wait`) that receives `externalFinalizerRequired` starts the same detached finalizer that `unit finish` starts. The detached finalizer runs in its own session with `--wait`; while its launcher is still alive it is refused like its launcher and retries on its interval, and it closes the owner once it is outside the owner's tree.

## Alternatives

- Reordering the close to run after releasing the locks was rejected. The ledger lock is what keeps `intent → submission → result` exclusive; executing outside it would let two finalizers submit the same close, and the dying process still could not write the result.
- Refusing without starting a survivor was rejected because the owner agent, the only caller in this flow, would be left with no path that closes its session.

Existing orphaned markers are recovered with `unit lock recover`; the original close intent is then reconciled by a surviving finalizer through the normal path.
