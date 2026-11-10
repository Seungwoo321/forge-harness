# Rebind a restarted existing native owner

## Context

An existing user session can resume its original native thread after its registered worker exits. The incarnation fence correctly rejects ordinary operations, and adoption correctly refuses replacing registered custody. Neither operation supplies an authorized recovery contract.

## Decision

An explicit public `unit session-rebind` uses the adoption transaction and its ledger/unit/goal locks to append a separate `rebindings` receipt. The complete previous custody digest and current unit/goal/target/source/policy bind fresh sourced permission. The original adoption and unit bytes remain immutable. Owner resolution uses the latest rebind.

The registered ownership is existing, with unchanged execution policy. The independently observed replacement has the same runtime, surface, canonical cwd, provider and primary native thread. A successful complete OS process listing proves the previous PID absent before and after observation; a live or reused PID, failed listing or ambiguous identity is refused. Source, target and native checks repeat before commit. An active reviewer or unresolved effect blocks replacement. The command sends no native input, starts no worker and terminates no process.

Exact replay revalidates permission, target, source, policy and current identity, and returns its immutable receipt. Stale revisions/digests, changed custody, conflicting identifiers and concurrent recovery fail closed. No extra approval phrase or manual record editing is part of the contract. Ordinary finish and retention rules apply to the recovered existing owner.
