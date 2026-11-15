# 0047 — Correct a completed delivery omission without erasing history

## Context

A finish request can supply delivery presentation while omitting its requested level. The default none level can close an otherwise reviewed unit even though the user authorized a merge. The merge policy is an authority cap and does not itself request delivery.

## Decision

A supplied delivery payload requires an explicit requestedDelivery. One audited completion correction recovers a Closed change unit whose original payload omitted that field and whose recorded delivery is none. It requires exact sourced human merge intent, merge authority, original request/result, current complete target and named correction paths, live original owner, no remote effects, and settled execution/queue proof.

The correction retains the original Closed result, acceptance, review, failures and goal completion in append-only history. It returns the same unit to Implementing and the same goal to active, invalidating acceptance, evidence and review. Normal scope amendment, mandatory gates and independent review apply before an explicit merge request. It does not promote a policy cap into a mandatory delivery level or reopen other completed workflows.
