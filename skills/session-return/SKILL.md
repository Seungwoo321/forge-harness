---
name: session-return
description: Return an independently completed review to its owning session and close the reviewer.
---

# Return a review

After submitting the independent review through the public stage command, call the installed `scripts/unit.mjs unit session-return <review-unit> --request <file> --adapters <module>`. The request supplies exact `parentRuntime`, the target owner's `returnTo` identity, `handoffContent`, and `resultFields`. The registered review and target identities are checked against the goal. The finalizer delivers immutable result, handoff and goal packets, then closes only the reviewer after native receipt and exact-owner observation. A pending result must be reconciled with `unit finalize`; the target may not finish while the reviewer is still open.
