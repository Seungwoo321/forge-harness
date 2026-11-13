# 0039: Sibling sandbox execution for repository self-tests

## Context

macOS refuses a distinct sandbox profile in an already sandboxed process with
`sandbox_apply: Operation not permitted` (exit 71). Reapplying the identical
profile succeeds. Repository tests that exercise isolated gate execution therefore
cannot run inside an ordinary macOS captured gate. Running the suite on the host
would lose live-tree exclusion, and excluding integration tests would lose coverage.

## Decision

A captured gate explicitly requests `config.nestedIsolation: "sibling-sandbox"`.
On macOS the host opens an authenticated, execution-scoped loopback broker before
starting the ordinary sandbox. Core command adapters in its descendants delegate
captured gate executions to this broker. Each request receives a separate native
sandbox from the host, rather than a profile applied inside its parent sandbox.

The broker accepts source roots only within the outer captured tree and snapshot
and temporary directories only within its declared writable outputs. Runtime tool
locations must be contained in the outer gate's tool locations. The captured-gate caller materializes and revalidates each input snapshot before
and after execution. The broker generates the native profile itself and applies
an additional fixed outer read/write boundary and live-source denial; it performs
no host file reads or writes on behalf of requests. The existing snapshot and
temporary locations remain intact for test coordination.
Each child receives a separate capability restricted to its own captured tree,
outputs and tool paths. Its descendants inherit every ancestor profile boundary.
Capabilities are revoked only after accepted descendants drain. Credentials live in private snapshot temporary files, not process arguments or
environment values. Descendant profiles explicitly deny reading, writing or linking
ancestor credential files. Child environment
data is supplied to the actual command after native isolation applies, never to
the unsandboxed launcher or in process arguments. Ordinary
commands and gates without this opt-in retain their native execution path.

The endpoint is not authority to launch arbitrary host commands: every accepted
request is executed by the captured-gate implementation in a fresh sandbox with
the above confinement. Invalid requests and unavailable brokers fail closed.
The broker drains accepted executions before the outer snapshot is removed.
Actual exit status and stdout follow the existing content-addressed report and
append-only evidence path. Configuration changes change the input fingerprint;
existing failed records are never rewritten or promoted to passing evidence.

## Consequences

The test runner and its inner gates keep native isolation without a VM dependency
or a weaker profile. Self-tests use a writable copy of the captured repository in
a declared output directory. The complete test command runs; no failure selection
or implicit host fallback occurs. Linux continues to use Bubblewrap.

The repository pins pnpm 12.15.0. pnpm 12.7.0 uses a fixed host `/tmp` store-lock
location, which cannot be allowed without broadening the sandbox. The upstream
[12.8.2 fix](https://pnpm.io/blog/releases/12.8.2) supports a private
`XDG_RUNTIME_DIR`; captured commands set it alongside `TMPDIR` to the reserved
snapshot temporary directory. The self-test bootstrap uses the exact discovered
package-manager executable, a private home, disabled global Git configuration,
and an independent temporary package scope for standalone test fixtures. It verifies
the declared package-manager version before disabling automatic version downloads.
Native developer tools are explicit runtime inputs; no user cache or global lock
location is added to the sandbox profile.
