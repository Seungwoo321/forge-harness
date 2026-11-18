# 0064: Confined snapshot cleanup through the gate broker

## Diagnosis

Snapshot cleanup must restore permissions on copied read-only output descendants without following a raced path outside its snapshot. A separate OS sandbox confines that work. macOS cannot apply a second sandbox from an already sandboxed gate, so nested cleanup must use the existing host broker just as nested gate execution does.

## Decision

The host broker accepts a separate cleanup request containing only a canonical root and its original device/inode identity. The root must be strictly below a captured writable output, and cannot contain any ancestor capability file. The host runs the fixed cleanup implementation in its own snapshot-confined OS sandbox and verifies the root identity before removing it. Requests supply no cleanup code, filesystem operation or sandbox profile.

Cleanup requests use the same capability lifetime and shutdown draining as execution requests. Invalid roots, identities and unavailable broker support fail closed. Cleanup errors retain the original command outcome and primary error; cleanup never supplies passing gate evidence.
