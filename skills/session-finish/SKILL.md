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

Take `parentRuntime` from this unit's custody entry in the goal record (`goals/<id>/goal.json` `adoptions`, `bootstraps` or `transfers`); the control plane verifies it against the live owner. Each `resultFields` value is one non-empty line (`changed` may be a list). If delivery already happened outside the harness, change the unit's delivery policy to `none` first; a delivery-only change keeps the independent review bound to the same content.

Finish is the step that starts the fresh successor context. Do not defer it to "a new session" when context is low.

For the final goal session, also pass `returnTo` with the exact identity (`sessionId`, `incarnationId`, `cwd`, `executable`) of the existing session that receives the result, usually the orchestrator that launched the goal. The control plane delivers the result there, verifies receipt, closes this worker and then records the goal as complete. Finishing a managed worker without `returnTo` is rejected with `RETURN_RECIPIENT_REQUIRED`, because the worker would otherwise stay open after the goal is complete.

An existing-owner adoption retains the user session through completion, return and same-session continuation; it never grants automatic close authority. Follow `docs/session-custody-recovery.md` for the public recovery contract.

If a target changes after goal completion is reserved, follow `docs/completion-recovery.md`. Recovery requires verified non-application and a trusted fence for the old executor; an absent PID or an empty-looking queue is not sufficient.
