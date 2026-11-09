# Recover an existing native goal start

A worker paused on startup trust can remain on an empty Ready composer after the original `session.start` execution returns uncertain. Resume it through the exact original public command, review unit, request, roots and adapter registration:

```sh
node <official-package>/scripts/unit.mjs unit session-start <existing-review-unit> \
  --request <original-start.json> --state-root <original-state-root> \
  --project-root <original-project-root> --adapters <original-trusted-adapters.mjs>
```

The existing native receiver and original intent/key/sequence remain authoritative. Verification never creates another workspace or worker. Do not recreate the review unit, run the effect's execute method manually, change the request or packet snapshots, type a manual goal, or edit stored records. Host trust decisions use the host's normal verified UI; this recovery does not grant hook trust or waive native enforcement requirements.

The public effect driver supplies `input.submission` to managed `session.start` adapter execution and verification. Registered session runners forward this in-process context intact. Its asynchronous `mark(binding)` appends and syncs a `submission` ledger row for the same intent before any native input; the binding contains runtime, session/incarnation, PID/executable, native thread, exact prompt/goal digest and immutable packet references. The context records recovery mode, prior binding and whether a prior completed effect makes the operation observation-only. A runner invoked outside that driver cannot manufacture this durable fence. No function is serialized into stored effect arguments and the public request schema stays unchanged.

For an unresolved legacy intent with no submission row, recovery needs positive native absence and the exact empty Ready receiver. Codex reads actual thread history and pending queue even when the native goal table has no row. Missing or unavailable history/queue, prior native work, queued input or another goal remains unknown. Claude requires an actual metadata-only transcript without user/assistant/queued work for legacy recovery; an unavailable startup transcript only permits the driver's fresh-launch execution path, never a replay. Native identity and composer contents are rechecked after durable persistence, at the first input, and before the separate Return. A foreign draft, modal, Working state, changed process/thread or changed packet refuses input.

Once any submission row exists, every retry is observation-only, including after process restart, goal clearing, delayed history or an uncertain write/Return. A completed legacy effect also stays observation-only without a new row. If persistence fails, no native input occurs. If persistence succeeds and the process exits before input, recovery deliberately remains uncertain; absence of a receipt does not authorize a second attempt. Preserve the original reviewer/intent and report that boundary to its owner rather than relaunching or deleting history.

An exact existing active/completed goal is reconciled only after native history establishes actual work start and all immutable packet reads. Managed hook enforcement and reviewer independence remain required. Successful reconciliation appends the real result to the original ledger sequence and registers that same reviewer through the normal goal custody path. Ordinary result delivery and exact managed-worker closure keep their existing contracts.
