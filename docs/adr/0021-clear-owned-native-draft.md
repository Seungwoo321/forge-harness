# Clear an owned native draft through verified input bytes

## Context

A named terminal control-key call can succeed while delivering no input bytes. Under Codex/Ghostty's keyboard enhancement flags, the observed named Ctrl-E/U path delivers zero bytes; the existing text input path preserves raw C0 bytes. A logical-line kill also cannot establish that a multiline textarea is empty. Synthetic fixtures must not substitute a successful key-call acknowledgement for actual native behavior.

## Decision

The pinned Codex nonempty normal-composer Ctrl-C handler preserves the cancelled draft locally and clears the complete buffer before the quit/interrupt branch. Correction sends exactly one verified raw `03` through the existing text input operation, after a synced edit boundary and repeated full owned nonempty Ready/native-absence checks. The exact target and nonqueued wire receipt are required. Actual empty is observed before any replacement text. A queued/unknown input or uncertain clear is never repeated.

An original legacy edit marker remains authoritative. One separate recovery-clear checkpoint is permitted only for its unchanged exact known damaged draft, matching binding/old-new digests, subsequent recorded failed-clear postcondition, and no confirmation/result. New clear rows identify their route; failures on the new route cannot reuse this legacy exception. Exact completed drafts still continue through the separate one-shot Return boundary. Foreign, modal, active, partial and unsupported states refuse mutation. Multiple logical lines and blank lines do not change the full-buffer contract.
