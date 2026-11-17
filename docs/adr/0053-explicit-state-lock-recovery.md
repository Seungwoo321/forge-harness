# Explicit recovery of abandoned critical-section markers

## Decision

Unit and ledger writers retain their existing PID markers and metadata. A dedicated OS advisory guard serializes each marker's writers and recovery, in ledger-before-unit order. Writes and cleanup assert the guard remains held. Nonblocking ledger callers remain nonblocking.

The public `unit lock recover` operation recovers one exact original marker under both guards. Every present marker must name a positive PID freshly observed absent by the native adapter before and after verification. Live, reused, unknown, malformed and reserved lease/fence markers reject. No automatic cleanup or new ownership protocol is introduced.

The trusted provider verifies the original user authorization, original account and native observations, complete original unit/goal/ledger and external effects, and fencing of legacy clients that do not participate in the guards. Scalar approval binds the complete recovery binding digest. The full verifier supplies one observation for every unresolved original effect, including null, running, pending, unknown and uncertain results. Retired effects remain retired.

Recovery publishes a durable receipt, preserves and fsyncs original marker bytes in an archive, then removes only the indicated marker. Replay validates the preserved archive digest. It never writes unit/goal revisions, ledger rows or external effect outcomes. Normal public reconciliation/finalization records any verified original outcome afterward.

## Rationale

An exited worker can leave a marker while the original operation's external result is still uncertain. Deleting the marker or treating the unit state as a close receipt risks duplicate effects. Exact native absence, exclusive guards, original authority and independently observed effects preserve the original operation and make recovery reviewable. Legacy fencing remains an explicit trusted host responsibility; absence of one PID alone cannot establish that older clients will not resume.
