# 0041: Correct a captured gate classification with verified resolution

## Decision

A captured gate diagnosis may identify a harness or environment cause without rewriting its original product label. `unit retry --request` accepts an explicit `classification` for that diagnosis only under `retry.onExhaustion: root-cause`. The trusted retry-resolution provider verifies the classification against the captured report, the diagnosis, actual correction and successful original reproduction. An unsupported assertion does not authorize product repair or recovery.

The receipt retains the original failure, cause and counters. Both ordinary diagnosis and exhausted diagnosis use this route. Ordinary recovery stays SelfGated; exhausted recovery uses ordinary resume. Both invalidate prior evidence and acceptance and require current mandatory gates and the existing independent review. The provider is checked again before the first successful mandatory-gate revalidation is recorded in classificationRevalidations. Later review fixes use ordinary implementation and acceptance; original failure and report bytes remain verified. No new owner or resolver is created.

## Rationale

A verifier's initial label is evidence, not authority to invent an application defect. Separating immutable captured facts from an independently verified correction preserves auditability while allowing the actual cause to be repaired. Existing retry-resolution observation uniqueness, ledger reconciliation and same-unit constraints continue to apply.
