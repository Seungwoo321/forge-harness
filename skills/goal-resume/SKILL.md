---
name: goal-resume
description: Resume a blocked goal after its recorded condition is resolved.
---

# Resume a goal

Call the installed `scripts/unit.mjs goal resume <id> --request <file>` from the project cwd. The request contains the current `expectedRevision`, stopped `unit`, and `resolutionEvidence`. The stopped owner must already have a verified close receipt. Resume the original unit using `unit resume`, inspect its pending effect ledger, then start the same unit through `session-start` using the next attempt. Do not create a duplicate session.
