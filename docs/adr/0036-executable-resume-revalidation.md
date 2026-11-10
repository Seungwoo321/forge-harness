# 0036: Make resume revalidation executable

## Decision

Resume executes `rerun-gate` and `revalidate` decisions for undelivered change units at SelfGated, InReview or Accepted. It first reconciles pending effects, Git/checkpoint inspection, complete evidence fingerprints and tracker projection. Under the existing ledger and unit locks it repeats revision and stopped-owner closure/authority validation, restores the recorded origin, and transitions to SelfGated. Scoped and Implementing origins resume their unfinished stage with invalidated evidence and reach mandatory gates through normal stage submission. Delivered, Closed and incompatible unit kinds cannot be reopened through this path.

An append-only revalidation entry preserves the decision and previous acceptance and review. Original evidence, failures, stage attempts, stop reports and custody remain intact. Invalidation appends stale evidence with no coverage; fresh acceptance executes the required gates against current inputs and requires the policy's independent review again. Independent evidence rerun retains its identical-input contract.

## Rationale

Returning a gate action while retaining Stopped makes required revalidation unreachable. Restoring Accepted without retiring its acceptance permits delivery before revalidation. Executing both steps atomically preserves the original unit and its audit while keeping authority and evidence checks at their existing boundaries.
