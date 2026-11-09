# Reconcile native goal input on the original effect

## Context

A managed worker can stop on startup trust before any native goal input. Once execution returns uncertain, read-only verification cannot submit the still-absent goal when the same receiver becomes Ready. Giving each verification a new volatile submission guard would permit duplicate input after an uncertain write or process restart.

## Decision

The effect ledger supplies a durable per-intent native submission fence to both execution and reconciliation. Before the first input mutation it appends and syncs a record bound to the exact runtime/process/thread, immutable prompt and packet references. A recorded fence makes all later attempts observation-only, including after a crash, cleared goal or delayed native history. A persistence failure prevents input.

Verification locates only the original effect's existing receiver and never creates another worker. A legacy intent without a fence can submit only when read-only native history and pending-input observations positively establish absence and the exact receiver has an empty settled composer. Missing history or queue evidence is unknown. Initial execution carries explicit fresh-launch provenance; missing Claude startup transcript does not authorize legacy reconciliation. Native identity and absence are rechecked at input boundaries, and drafts/modals remain protected. A started result still requires the exact native goal, packet reads, hook evidence and actual work start.

Existing unit, goal, reviewer, effect sequence, authorization and failure history remain intact. The public session-start request and ordinary delivery/close contracts do not change.
