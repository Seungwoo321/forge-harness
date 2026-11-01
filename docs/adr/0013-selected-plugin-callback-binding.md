# ADR 0013: Selected plugin callback binding

## Status

Accepted. This decision defines the Studio Kit App and Forge callback boundary. End-to-end lifecycle enforcement remains unsupported until all three event paths satisfy the acceptance criteria in `docs/spec.md` §14.6.

## Context

Studio Harness declares `prepareProjectSession`, `beforeUnitScopeSubmission`, and `beforeAcceptanceSubmission` callbacks. Provider-native Claude Code and Codex hooks are separate host events and do not invoke these callbacks. Forge has no completed lifecycle call sites for the selected-engine callbacks.

The active Studio Kit App project profile is the user's sole plugin selection and approval authority. A second Forge allow-list would duplicate that decision and could disagree with the deployed project state. A project-local JSON file can be edited independently, so its contents alone cannot prove that the App profile still selects the package or that its deployment is applied.

## Decision

Forge reads the App-generated, ignored `.local/studio-kit/plugin-bindings.json` receipt as a deployment projection. Before invoking a callback, Forge queries the project-bound Studio Kit App API at `GET /v1/profiles/current/plugin-bindings?projectRoot=<canonical-project-root>` with the session bearer token. Only HTTP 200 with a current App profile and applied deployment is accepted; Forge compares the response to the local receipt and rejects every missing, stale, unauthorized, malformed, or mismatched result.

The receipt schema is version 1: `profile` carries `id` and `revision`; `deployment` carries `operationId`, `revision`, and `state`; `plugins` carries `id`, `version`, `digest`, and project-local `root`. The selected package root is `.local/studio-kit/packages/<id>/<version>`. Forge verifies the complete installed package snapshot, plugin ID/version, manifest and callback-catalog `schemaVersion`, and event `contractVersion` before invocation. The full package digest hashes byte-sorted UTF-8 relative paths, normalized executable modes, and file bytes with 64-bit big-endian path and content lengths; only top-level `.git`, `.local`, and `node_modules` are excluded. Symlinks and special files reject.

The three events use `schemaVersion: 1` and `contractVersion: "1"`. A callback is read-only and returns the unchanged input on success; rejection, exception, malformed output, timeout, stale context, or unsupported isolation stops the dispatch and forwards no input or transition. Forge executes the verified callback in a killable, least-privilege child process. Before a lifecycle transition, Forge rechecks the expected revision and input fingerprint in the same state update transaction.

Codex native hook trust remains a separate host gate. Selected-engine callback approval never implies that a Codex hook definition is trusted or active.

## Consequences

- Project-profile selection and approval have one authority: Studio Kit App.
- The local receipt is not an editable approval source and never creates a Forge selection setting.
- Callback support remains reported as unsupported until Forge exposes and verifies all three lifecycle paths, including transition-time revision/fingerprint checks.
- The current Forge Unit Record and StageInput do not contain all confirmed v1 callback context. In particular, scope input has no owner/actualOwner or current-digest source rows, acceptance evidence has per-gate fingerprints rather than the callback's shared fingerprint shape, and session preparation context belongs to the App. The dispatcher module alone does not establish lifecycle enforcement.
- Provider-native Codex trust status remains independent and cannot be bypassed by this binding.
