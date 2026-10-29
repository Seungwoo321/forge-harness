# ADR 0004: Generic session adapter contract

Date: 2026-10-29 · Scope: `docs/spec.md`

## Context

`unit finish` records a session start intent and delegates owner observation, session creation, and intent reconciliation to the registered session adapter. The default adapter factory previously exposed no session adapter, so the finish path could not use a configured runner.

## Decision

The harness registers a runner through the generic adapter factory. A runner declares `contractVersion: "harness.session-adapter/1"`, the capabilities `fix-forward`, `failure-classification-five-way`, `retry-limit`, `ops-e0-only`, and `policy-review`, and implements `observe`, `execute`, and `verify`. Unsupported registrations fail before handoff side effects. The adapter remains runner-neutral; runner-specific behavior stays inside the registered implementation.

## Consequences

The Unit finish flow uses the same registered adapter for current-owner preflight, effect execution, and uncertainty reconciliation. The effect ledger remains the authority for whether a successor start completed.
