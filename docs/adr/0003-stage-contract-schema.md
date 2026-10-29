# ADR-0003: Versioned stage contracts and schemas

## Status

Accepted

## Context

The control plane accepts StageOutput from non-deterministic stage workers, so it needs a stable, dependency-free contract boundary. General JSON Schema would add a dependency and allow keywords whose interpretation the Node control plane does not implement.

## Decision

Each stage declares `harness.contract/1` and `harness.schema/1` identifiers, Unit Record reads and writes, and input/output schemas in `contract.json`. The control plane owns read readiness: a declared read must have an upstream writer and a prepared non-null value before an input is opened. Pure validators check contract shape, input/output values, and read readiness; they do not persist state or perform transitions. Unsupported identifiers and schema keywords are rejected.

## Consequences

The schema vocabulary remains a small explicit subset implemented with Node built-ins. Objects declare `properties`; `additionalProperties: false` closes a schema, while omission keeps opaque prepared data open. The control plane remains the only writer of Unit Record state. Extending the vocabulary requires a versioned contract decision and matching validation tests.
