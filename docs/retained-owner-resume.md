# Retained live owner after external resolution

A recipient-free stop may retain a live implementation owner whose original user-domain/defer blocker is an actual external dependency. Its resolution uses the existing public `goal resume` and `unit resume` commands with an explicit external-resolution request. Binding-only clarification and verified closed-owner recovery remain separate paths.

```json
{
  "id":"resolved-external-1",
  "expectedRevision":13,
  "unit":"change",
  "unitDigest":"sha256:<whole current stopped unit>",
  "goalDigest":"sha256:<whole blocked goal>",
  "ledgerDigest":"sha256:<whole current ledger rows>",
  "targetDigest":"sha256:<live original accepted target>",
  "custodyDigest":"sha256:<original current custody>",
  "externalResolution":{"ref":"<absolute original goal.source.path>","digest":"sha256:<original source bytes>"},
  "resolutionEvidence":{"ref":"<absolute actual resolution evidence file>","digest":"sha256:<resolution bytes>"},
  "reason":"The recorded external blocker is actually resolved; continue the same owner"
}
```

Run `goal resume <goal> --request <file> --user-input <actual-original-human-ref>` from the original project with its installed adapters. No operational coordination message grants new authority. The request's original source must equal `goal.source` exactly. `resolutionEvidence` is a byte-hashed file; its claims alone do not prove resolution.

The core requires the exact current Stopped-from-Accepted change unit and blocked goal, settled original reviews/effects, unchanged accepted content and live native custody, immutable original stop/failure/source/canon bytes, and no completion/rework reservation, delivery plan or finalization. It requires trusted `verifyUserInput` and an independent read-only `provider.verifyRetainedExternalResume` callback. Missing, stale, conflicting, foreign or unproven facts fail closed.

The callback receives these exact scalar bindings:

- `unit`, `goalId`, `userInputRef`, `effect:'goal.resume.retained-external'`;
- `argsDigest` of `{request,userInputRef}`;
- `unitDigest`, `goalDigest`, `ledgerDigest`, `targetDigest`, `custodyDigest`;
- `sourceDigest`, `resolutionDigest`, `acceptedDigest`, `stopReportDigest`, `failureDigest`, `policyDigest`.

It also receives structured `request`, `record`, `goal`, `target` and original `failure` copies. It independently reads the actual original human/source and external system: that human authorized continuation by this exact owner, the recorded failure is genuinely external, the actual resolution meets its original condition, and no other blocker remains. It returns all scalar bindings exactly with `verified:true, externalResolved:true`. Echoing the input, an unrelated approval, a resolution file's assertions or `bindingOnly:true` do not prove these facts.

Goal resume only activates the same goal and appends one `retainedExternalResumptions` receipt plus blocker history. The unit remains Stopped with its Accepted object unchanged. Replaying the identical request after this goal commit rechecks the original tuple and returns the same receipt; a changed request is rejected.

Next, ordinary `unit resume <unit> --snapshot <file>` must supply current Git/checkpoint/fingerprint/tracker observations. Under the original request's recovery locks it rechecks all original proofs, custody and target. A complete matching snapshot requires gate revalidation even if old fingerprints still match: the same unit passes through SelfGated into Implementing, with prior acceptance/review preserved in `resumeRevalidations`, original gate rows retained and invalidation rows appended with stale status and empty coverage. Current acceptance/review are cleared. Required gates and policy-required independent review must pass before delivery. Inspection/reconciliation decisions remain nonmutating; source or target changes during the two-phase resume are refused.

After this boundary, the original owner opens the ordinary implement stage, performs any approved base integration within scope, submits the result and revalidates that integrated tree. No Accepted-only reopen is needed; implementation submission must precede acceptance. Resume never updates a base, creates a worker, synthesizes closure/delivery, waives review or edits the original failure/custody/history. `session-start` is not used for this retained live owner.

Rationale: [ADR 0059](adr/0059-retained-external-resolution-resume.md).
