# Rebind a completed implementation after reopening

## Context

A normal commit can advance HEAD after acceptance without changing the approved tree. An authorized reopen and later base integration preserve the prior implementation head and completed stage. Scope recheck only resolves scope findings. The checkpoint guard correctly rejects opening at that stale head, but the existing restart route accepts only open or superseded attempts.

## Decision

The existing explicit implementation stage restart also accepts its latest completed attempt when a newer recorded reopening authorizes renewed implementation. Exact attempt/input digest/checkpoint head and current requested new head, checkpoint inspection, descendant ancestry and Git HEAD/ref locks remain mandatory. The completed result and all earlier evidence remain intact. The restart audit binds the newer reopening and current head for the successor checkpoint; it does not create acceptance or review evidence.

An immutable pending StageInput left by a failed open is validated against the preceding binding and preserved. Its number is skipped rather than its bytes overwritten. Idempotent replay and an explicitly validated later descendant-head refresh use the same recovery path. Completed stages without a newer reopen, unrelated ancestry, stale head requests and concurrent ref changes remain rejected. Reopen and scope recheck retain their existing responsibilities; no Git worktree/head/index mutation or historical evidence reset is part of recovery.
