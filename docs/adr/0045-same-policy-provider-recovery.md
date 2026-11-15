# 0045 — Recover an unstarted receiver after a verified provider correction

## Context

A configured native provider can fail after its durable submission boundary and before Return. The owned receiver can remain unstarted with a partial slash draft. Pending-draft continuation deliberately rejects partial or foreign input, while session-recover requires an execution-policy change. Changing a policy merely to satisfy recovery obscures the actual provider defect.

## Decision

The existing explicit session-recover contract also accepts an unchanged execution policy when the trusted non-start provider verifies a real provider correction. It returns different original and corrected provider-input digests and an evidence digest identical to the original provenance file. Exact sourced authority, original native account/history, stopped receiver, cancelled queue, immutable source/intent, locks and ledger requirements remain mandatory. A live receiver or partial draft alone never permits another start.

The source owner can verify a development provider through the existing adapter interface. Fresh Orca evidence requires the exact rendered receiver and a complete response without a line limit cut. Retained-output truncation is distinct. Native version, welcome, Ready, account, process/thread, owned queue/goal, trust, packet-read, task-start and durable input fences remain intact.

No record reset, synthetic result, manual native goal or artificial policy change is a recovery path. The old intent and every input/Return boundary remain visible; public recovery reserves the next attempt without launching it.
