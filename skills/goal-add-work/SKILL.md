---
name: goal-add-work
description: Append approved work to an active goal without losing its existing sequence.
---

# Add goal work

Call the installed `scripts/unit.mjs goal add-work <id> --request <file>` from the project cwd. The JSON request contains the current `expectedRevision`, an ordered nonempty `units` array, and `evidence` referencing the approved scope or decision. Add only work within the authorized goal. A new unit identifier must not duplicate outstanding or completed work. Do not alter the goal record directly or declare it complete while approved work remains.
