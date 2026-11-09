---
name: session-start
description: Start the initial goal-bound session using the configured runtime.
---

# Start a goal session

Call the installed `scripts/unit.mjs unit session-start <unit> --request <file> --adapters <module>` in the project cwd. The registered unit must reference an active goal. For an independent reviewer, first create the review unit with `{"kind": "review", "targetUnit": "<unit>", "goalId": "<goal>", "request": {...}}`; the `goalId` binds the review unit to the goal, and an unbound review unit is refused. The request identifies the exact parent runtime, successor cwd and an absolute immutable handoff path and digest. The runtime uses the registered goal's execution policy and verifies both goal and handoff reads and actual task start. The call keeps re-observing a start whose receipt is not yet visible for up to `waitSeconds` (default 180) so the registration completes in the same call. If it still returns uncertain, re-run the same request and adapter right away instead of waiting idle; do not start another session. A process or queue alone is not a receipt.

If startup trust leaves the existing worker Ready with an uncertain original intent, rerun the exact public command/request after the host trust decision. Follow packaged `docs/native-goal-recovery.md`: preserve the same unit/receiver/key/sequence, never relaunch or type a manual goal. A durable submission fence makes every later replay observation-only; an uncertain mutation is not permission to submit again.
