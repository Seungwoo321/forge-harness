# ADR 0005: Public runtime adapter registration

Date: 2026-10-29 · Scope: public Unit executable and delivery

## Decision

The executable accepts an explicit trusted `--adapters <module>` exporting `createRuntimeAdapters({cwd, adapters})`. The factory receives the product cwd and immutable core services. It may provide only `git`, `gates`, `tracker`, and `sessionRunner`; registration never replaces command, clock, identity, or checkpoint services. Module and registration failures produce structured CLI results. Unit start requests retain policy overrides; a sibling integration is not a workspace policy root.

Runtime bindings use native cmux or Orca commands through the command adapter. Owner preflight and successor observation bind the terminal identity and its observed cwd. Unknown starts remain unresolved; reconciliation observes existing targets and never launches again.

Parent runtime and successor working directory are separate inputs. A finish request may specify `parentRuntime: {sessionId,cwd,incarnationId}` while `successor.cwd` identifies another checkout. Native runtime configuration fixes the parent identity and cwd; preflight observes that parent and independently validates the target directory. Successor observation checks the launched terminal at the target cwd. Legacy parentSessionId retains same-directory behavior, and conflicting identities are rejected.

Canonical filesystem target validation is not proof of a running worker. Runtime observations separately bind terminal identity and incarnation to the observed process cwd; ambiguous or changed observations fail closed. The parent is observed again immediately before the ledger executes a new start, after result preparation and tracker projection. Reconciliation only observes an existing worker.

Orca registers a `runtimeRpc(method, params)` transport with its configured session runner. The adapter calls the native `terminal.inspectProcess` schema and binds live foreground process evidence to independent OS PID, start-time, tty, process-group, executable, and cwd observations, then checks the native fence again. The configuration module owns SDK discovery, supported version, and disposal; the core embeds no installation path. Orca's registered worktree path is context and is never substituted for the actual process cwd. cmux uses its native caller/terminal/tty identity and independent OS foreground process observations. A newly created terminal alone is not a started worker: the observed executable must match the configured launch executable.

Finish drives Accepted through Delivering to Delivered. Delivery none records `{level:"none",head,mergeHead:null,effectRefs:[]}` without an external effect. A resumed Delivering unit rechecks accepted head and content before completing delivery. Changed targets return to SelfGated. Gate evidence keeps original verdict, path, and key references supplied by its provider.

## Consequences

The Unit state store and effect ledger remain lifecycle authorities. Runtime configuration supplies integrations without implicit policy imports or product-specific core code. Higher delivery levels require an explicit effect plan and the existing ledger authorization and content binding rules.
