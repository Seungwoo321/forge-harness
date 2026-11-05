---
name: session-stop
description: Record a blocked unit's context and transfer ownership only when a recipient is supplied.
---

# Stop a blocked session

After `unit fail` has recorded the real stopping reason and the goal is blocked, call the installed `scripts/unit.mjs unit session-stop <unit> --request <file> --adapters <module>` with the same project and state roots. The request supplies `parentRuntime`, `handoffContent`, `resultFields`, and an allowed `classification`; the recorded blocker supplies the reason and resume condition. With no recipient, report the preserved result and blocker to the user and keep the owner terminal open. With a distinct existing `returnTo` recipient, the control plane preserves immutable packets and starts a surviving finalizer. Use `unit finalize <unit>` with the same roots and adapter until receipt and exact-owner closure are verified. Never close the recipient or restart an uncertain effect.
