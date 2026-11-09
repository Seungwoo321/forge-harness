# Fence native result-delivery input on its original intent

## Context

An original delivery can fail before paste and leave a valid empty composer. Observing only an exact pending draft cannot recover it. An in-memory attempted flag also cannot prevent duplicate input after a process crash. Repeated unknown observations do not establish that a native input attempt occurred.

## Decision

Interactive Codex result delivery uses the existing ledger submission and confirmation checkpoints on the original intent/key/sequence. The binding includes the measured process/session/incarnation/native thread, cwd, executable, full prompt digest and immutable packet identities. Public verification may perform the first submission only after full native history and queue establish that this exact reference is absent and the supported composer is empty. Native query errors remain unknown.

Submission is synced before paste, and confirmation is synced separately before Return. Native identity/queue and the full unchanged composer are checked again after each checkpoint. An uncertain paste is never repeated. An exact pending reference with the same binding can continue through its unused confirmation; a consumed confirmation cannot repeat. Queued, accepted or started requests are observed without submission. Actual activity and packet-read evidence remain necessary for completion and closure.

Existing unknown observation rows remain in place and do not consume a first input checkpoint. This is the same original effect, not a new retry intent or a policy-limit increase. Existing custom-adapter retry behavior remains bounded. No direct input, manual state edits, duplicate receiver, synthetic receipt or hook trust bypass forms part of recovery.
