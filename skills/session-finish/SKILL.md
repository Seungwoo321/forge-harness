---
name: session-finish
description: Finish an accepted unit through the goal-bound handoff and finalization control plane.
---

# Finish a session

Call the installed `scripts/unit.mjs unit finish <unit> --request <file> --adapters <module>` from the project cwd. For remaining goal work, supply the approved successor, exact parent runtime and the complete handoff. For an actual final goal completion, supply `goalComplete: true` and `goalProof` entries mapping each goal criterion verbatim to a covered acceptance of an accepted goal unit. Never use a unit's acceptance as proof that the overall goal is complete. Provide a distinct `returnTo` recipient for the last goal session. The control plane verifies the successor's goal, handoff and result before closing the owner. A pending outcome is not closed; use `unit finalize` with the original roots and adapter. Use `goal reconcile <id>` to complete a previously recorded goal completion after a crash.
