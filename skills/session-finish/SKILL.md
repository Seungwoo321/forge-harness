---
name: session-finish
description: Finish an accepted unit through the goal-bound handoff and finalization control plane.
---

# Finish a session

Call the installed `scripts/unit.mjs unit finish <unit> --request <file> --adapters <module>` from the project cwd. For remaining goal work, supply the approved successor, exact parent runtime and the complete handoff. For an actual final goal completion, supply `goalComplete: true` and `goalProof` entries mapping each goal criterion verbatim to a covered acceptance of an accepted goal unit. Never use a unit's acceptance as proof that the overall goal is complete. Provide a distinct `returnTo` recipient for the last goal session. The control plane verifies the successor's goal, handoff and result before closing the owner. A pending outcome is not closed; use `unit finalize` with the original roots and adapter. Use `goal reconcile <id>` to complete a previously recorded goal completion after a crash.

## Request shape

Hand off remaining goal work to a successor session:

```json
{
  "successor": { "approved": true, "unit": "<next-unit>", "cwd": "<absolute successor cwd>" },
  "parentRuntime": { "sessionId": "<owner>", "incarnationId": "<owner incarnation>", "cwd": "<owner cwd>" },
  "handoffContent": "<complete handoff: state, decisions, remaining work, first action>",
  "resultFields": {
    "title": "…", "objective": "…", "acceptance": "…", "tracking": "…", "decision": "…",
    "changed": ["…"], "verification": "…", "remainingRisk": "…", "nextFirstAction": "…"
  }
}
```

Take `parentRuntime` from this unit's custody entry in the goal record (`goals/<id>/goal.json` `bootstraps` or `transfers`); the control plane verifies it against the live owner. Each `resultFields` value is one non-empty line (`changed` may be a list). If delivery already happened outside the harness, change the unit's delivery policy to `none` first; a delivery-only change keeps the independent review bound to the same content.

Finish is the step that starts the fresh successor context. Do not defer it to "a new session" when context is low.
