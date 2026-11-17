---
name: goal-resume
description: Resume a blocked goal after its recorded condition is resolved.
---

# Resume a goal

Call the installed `scripts/unit.mjs goal resume <id> --request <file>` from the project cwd. The request contains the current `expectedRevision`, stopped `unit`, and `resolutionEvidence`. The stopped owner must already have a verified close receipt. Resume the original unit using `unit resume`, inspect its pending effect ledger, then start the same unit through `session-start` using the next attempt. Do not create a duplicate session.

A recipient-free stop with the same live Accepted owner uses an explicit [retained external-resolution request](../../docs/retained-owner-resume.md) when the actual external blocker is resolved. This requires independently verified original human continuation authority and actual resolution, then the same `unit resume` with mandatory gates/review revalidation. Preserve the original owner, Accepted/history and stop packets; do not require or invent closure, start a new session, or relabel an external wait as binding clarification. The binding-only clarification path remains limited to its own contract.
