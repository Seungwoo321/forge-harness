---
name: session-stop
description: Transfer an externally blocked unit's context and close its exact owner session.
---

# Stop a blocked session

After `unit fail` has recorded the real stopping reason and the goal is blocked, call the installed `scripts/unit.mjs unit session-stop <unit> --request <file> --adapters <module>` with the same project and state roots. The request supplies `parentRuntime`, a distinct existing `returnTo` recipient, `handoffContent`, `resultFields`, and an allowed `classification`. The recorded blocker supplies the resume condition. The control plane preserves immutable goal, handoff and result packets and starts a surviving finalizer. A pending result is not complete: use `unit finalize <unit>` with the same roots and adapter until receipt and exact-owner closure are verified. Never close the recipient or restart an uncertain effect.
