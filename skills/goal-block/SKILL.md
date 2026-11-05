---
name: goal-block
description: Record an actual goal blocker and its resumption condition.
---

# Record a blocker

Call the installed `scripts/unit.mjs goal block <id> --request <file>` from the project cwd. The JSON request contains the current `expectedRevision`, stopped `unit`, `reason`, `evidence`, and `resumeCondition`. Report the result and preserve the existing unit, owner and pending effects. Do not claim the goal or session is complete. Record the affected unit failure first. For a stopped owner, use `session-stop` to transfer the blocked context and verify exact-owner closure. Do not start an unrelated successor or retry an uncertain effect.
