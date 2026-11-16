# 0050 — Recover initial goal binding for legacy submitted records

## Context

Submitted records created before the continuity requirement was introduced lack the `continuityRequired` property. A truthiness eligibility check rejects those records before the existing source authorization can run. An absent historical property differs from an explicitly disabled or malformed requirement.

## Decision

Explicit initial goal-binding recovery accepts either `continuityRequired: true` or an absent own property. Every explicit non-true value remains ineligible. The existing exact unit, goal, source, target, authorization and custody checks apply to both shapes.

After all checks succeed, the unit's atomic binding commit sets `continuityRequired: true`. For a legacy record, the append-only receipt records `previous.continuityRequiredAbsent: true`. Failed verification changes neither the field nor the unit or goal. Exact replay returns the original receipt without another revision.

Binding preserves existing state, policy, failed evidence, pending review and stage history. It creates no native custody, acceptance, delivery or session receipt. Normal initial binding and the separate session adoption contract retain their existing requirements.
