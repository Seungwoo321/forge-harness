---
name: goal-add-work
description: Append approved work to an active goal without losing its existing sequence.
---

# Add goal work

Call the installed `scripts/unit.mjs goal add-work <id> --request <file>` from the project cwd. The JSON request contains the current `expectedRevision`, an ordered nonempty `units` array, and `evidence` referencing the approved scope or decision. Add only work within the authorized goal. A new unit identifier must not duplicate outstanding or completed work. Do not alter the goal record directly or declare it complete while approved work remains.

When added work changes what completes the goal, amend the goal with the user's approval: `scripts/unit.mjs goal amend <id> --request <file> --user-input <ref>` with `{"expectedRevision", "reason", "objective", "criteria": [...]}`. Write each criterion as the exact acceptance text of the unit that will prove it; goal completion maps every criterion verbatim to a covered acceptance of an accepted goal unit.
