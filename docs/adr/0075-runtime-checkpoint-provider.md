# 0075 — Runtime checkpoint provider

A host `git.inspectUnit` provider may observe a unit's content differently from the raw repository HEAD. For example, after a unit's change was delivered externally and the feature branch then cleanly merged the advanced release line, the host observes the delivered unit content: the submitted head and tree.

The core checkpoint adapter, however, always compared the stage's expected head with the real HEAD. A review stage open therefore failed with `CHECKPOINT_STALE` while acceptance, using the host observation, had succeeded. Runtime providers could not register a checkpoint implementation.

`checkpoint` is now a registrable runtime provider with `createCheckpoint` and `inspectChanges`, validated like the other providers. When registered, it replaces the core Git checkpoint adapter for every stage open, submission attribution, review input patch, restart and shared-unit inspection. A host that projects the unit observation must project checkpoints on the same basis, so that every comparison of recorded and current content uses one rule. Hosts that do not register it keep the core behavior unchanged.
