# Existing owner custody recovery

`unit session-adopt` registers the independently observed existing native owner of the current goal-bound change unit. Supported states are Scoped, Implementing, SelfGated, InReview and Accepted. The unit file is preserved byte-for-byte, including revision, acceptance amendments/corrections, evidence, failures and authority/review/retry policy. InReview with accepted=null is supported. The goal receives one append-only `adoptions` receipt with `ownership: existing`; no bootstrap, task-start or enforcement receipt is fabricated.

Run from the exact canonical owner cwd with the original explicit roots and trusted adapter module:

```sh
node <package>/scripts/unit.mjs unit session-adopt <existing-unit> \
  --request adoption.json --user-input <actual-user-input-ref> \
  --state-root <original-state-root> --project-root <original-project-root> \
  --adapters <trusted-adapters.mjs>
```

The request contains exactly:

```json
{
  "id": "adopt-existing-owner",
  "expectedRevision": 36,
  "expectedGoalRevision": 4,
  "unitDigest": "sha256:<canonical-unit-digest>",
  "goalDigest": "sha256:<canonical-goal-record-digest>",
  "targetDigest": "sha256:<current-inspected-target-digest>",
  "owner": {
    "runtime": "cmux",
    "sessionId": "actual-surface-or-terminal",
    "incarnationId": "actual-runtime-incarnation",
    "cwd": "/work/product",
    "worker": {
      "executable": "/bin/codex",
      "pid": 42,
      "incarnationId": "actual-process-incarnation",
      "threadId": "actual-native-thread"
    }
  },
  "provenance": {"ref": "actual-permission-source", "digest": "sha256:<source-bytes-digest>"},
  "reason": "User authorized this existing native owner for the current goal and unit"
}
```

All object digests use the exported `effectArgsDigest` from `scripts/lib/approvals.mjs` (recursively sorted object keys, JSON serialization, SHA-256). `unitDigest` hashes the complete current Unit Record; `goalDigest` hashes the complete current Goal Record, including policy/source/revision. `targetDigest` hashes the full result of the trusted `git.inspectUnit({unit,record})`, rather than a caller-selected subset. The provenance digest hashes actual source bytes. Capture owner fields from read-only `session.observe`, not copied terminal labels or generated identifiers. Do not add closable or task fields to the owner request.

The registered runtime provider supplies `verifyUserInput` and read-only `verifySessionAdoption`. Both verify actual authority rather than echoing a request. `verifyUserInput` receives `{unit,goalId,userInputRef,argsDigest,unitDigest,goalDigest,targetDigest,ownerDigest,policyDigest,effect,reason}` with effect `unit.session.adopt`. `argsDigest` hashes `{request,userInputRef}`. `verifySessionAdoption` receives the same digest binding without effect/reason plus structured clones of `{request,record,goal,target}`. Each returns `verified:true` and exactly matching scalar binding fields only after verifying the actual user instruction and provenance authorize this exact native owner, unit, source, current target and execution policy. It verifies the owner's actual account/configuration against the currently authorized goal execution policy; historical unit session configuration is preserved and is not an execution-policy equality requirement. Missing or unverifiable source/authority blocks recovery. This provider contract never authorizes an unconditional success callback.

The native observer independently establishes runtime caller, canonical cwd, unique live process/incarnation and native thread. Native observation and Git/goal-source/unit-canonical-source checks repeat before commit under ledger/unit/goal locks. A registered owner, existing reviewer custody, unresolved effect, stale revision/digest/target/source, mismatched runtime/provider/cwd or ambiguous native owner blocks adoption. No existing registered owner is taken over, including one whose liveness cannot be established. Replaying the exact id/request revalidates permission, policy, target and native identity and returns the existing receipt; changed payloads conflict. A second id cannot replace custody. Changes after initial capture require fresh source-backed authorization and a newly captured request, without editing stored records.

After adoption, create the independent review with `{kind:"review",targetUnit,goalId,request:{text,userInputRef}}` under the currently authorized project/goal session policy, then use normal `unit session-start <review-unit> --request <review-start.json>`. The start request retains its normal `{cwd,handoffPath,handoffDigest,parentRuntime,waitSeconds}` contract. `parentRuntime` identifies the adopted owner. Native review start and immutable packet receipts remain mandatory; the reviewer must have a distinct runtime session and native thread. The immutable start intent and reviewer registration bind the original complete target digest and native reviewer thread. A changed target, criterion history or authority cannot reuse that reviewer. Reobservation, effect result and reviewer registration share target/goal custody. An uncertain start reuses its original ledger intent and goal snapshot; changed source/policy/target blocks further effects rather than launching a duplicate.

The separate verified reviewer opens/submits its normal review StageInput/StageOutput, then runs `session-return` to the adopted owner and reconciles `finalize`. Its returnTo supplies the observed owner identity and executable. Configure the reviewer's `parent.recipientEnv` for that actual owner's account and `parent.workerEnv` for the reviewer. `session.observe({recipient,nativeOwner:true})` independently observes the recipient native thread using recipientEnv. Finalization reobserves the adopted recipient at delivery/close boundaries and closes only the managed reviewer. The implementation owner then uses ordinary acceptance and finish; review obligations remain in force.

Existing ownership never grants automatic close permission, even when an adapter describes the surface as closable. Recipient-free goal completion closes the unit and goal while retaining the user session. An explicit return/transfer delivers the real result and records retained ownership without a session.close effect. Same-session continuation propagates the existing ownership type. Managed bootstrap/transfer/reviewer closure contracts remain intact.

The packaged `scripts/session-adapter.mjs` reads `request.owner` for session-adopt, loads the current goal policy for native account environments and sets closable=false for existing custody. Normal stage submission resolves the registered managed reviewer from goal custody. Compose that session runner with the trusted Git and source-permission providers through the existing runtime adapter registration; the packaged observer alone does not supply or manufacture user authorization.
