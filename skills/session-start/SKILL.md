---
name: session-start
description: Start the initial goal-bound session using the configured runtime.
---

# Start a goal session

Call the installed `scripts/unit.mjs unit session-start <unit> --request <file> --adapters <module>` in the project cwd. The registered unit must reference an active goal. The request identifies the exact parent runtime, successor cwd and an absolute immutable handoff path and digest. The runtime uses the registered goal's execution policy and verifies both goal and handoff reads and actual task start. Reuse the same request and adapter on uncertain outcomes; do not start another session. A process or queue alone is not a receipt.
