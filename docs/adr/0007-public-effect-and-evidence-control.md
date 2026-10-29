# ADR 0007: Public effect execution and evidence reruns

Date: 2026-10-29 · Scope: public effect and evidence commands

## Decision

The trusted runtime factory registers `effect` and `effectContext` together. The effect provider implements `execute` and `verify`; its context verifies the same ownership, scope, environment, irreversibility, secret, and command boundaries as delivery. Public requests pass registered argument validation and the existing ledger pipeline. E4 requests use exact stored approvals and reverify the accepted target and trusted user input before execution. Implementing permits ordinary effects; Accepted and Delivering permit approved E4 requests.

`evidence rerun <unit> --gate <id>` requires existing evidence and the same described input fingerprint, bypasses successful-result reuse, and persists the independently executed result and comparison. Invalid reports and environment, harness, user-domain, and unknown failures cannot establish nondeterminism. Divergent valid outcomes invalidate the gate's passing evidence for that fingerprint; later acceptance cannot erase that classification.

## Consequences

The existing Unit record, approval verifier, policy, ledger, and gate runner retain authority. Runtime registration adds no replacement clock, identity, or command service. Tests exercise the public executable with supplied providers and stub effect commands.
