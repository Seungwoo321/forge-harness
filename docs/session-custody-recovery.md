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

## Restarted owner

`unit session-rebind <existing-unit> --request rebind.json --user-input <actual-user-input-ref>` uses the same explicit roots and trusted adapters. Its request has all adoption fields above plus `previousCustodyDigest`, the `effectArgsDigest` of the complete current `goalOwner(goal, unit)` receipt. `owner` is the independently measured replacement. Rebind requires existing ownership with the same runtime, surface, canonical cwd, provider and native primary thread, a different PID (and process incarnation for cmux; Orca retains its terminal incarnation), and the unchanged execution policy bound by previous custody. An active reviewer, finalization/delivery plan or unresolved effect blocks rebind. The command runs from the exact canonical owner cwd.

The registered provider implements `verifyUserInput` with effect `unit.session.rebind` and `verifySessionRebind`. Both bind the same scalar fields as adoption plus `previousCustodyDigest`. `verifySessionRebind` also receives structured clones of `{request,record,goal,target,previousCustody}`; `previousCustody` is the complete immutable previous receipt. Each successful callback returns `verified:true` and every scalar binding unchanged. It independently verifies actual sourced authority and provenance for this same-unit recovery and current account/configuration, without a new approval phrase. Echoing the caller's assertion is not verification.

`session.observe({cwd,targetCwd,previousOwner})` supplies the actual previous `owner` identity. The packaged observer requires a successful complete OS PID listing before and after the current unique native worker/thread observation. Any live or reused previous PID, failed or ambiguous observation blocks recovery. Only proven absence returns `previousOwnerAbsent:true` alongside the current identity. Core recovery requires this flag and exact current identity, repeats the observations/source/target checks, and commits under ledger/unit/goal locks. The adapter reads the rebind request's owner and current goal account; it does not authorize the request.

The goal appends one `rebindings` receipt linking `previousCustodyDigest`, request/permission/current owner, policy and next goal revision. Original `adoptions`, unit bytes/revision and all review/gate/acceptance/failure evidence remain unchanged. `goalOwner` resolves the latest rebind for the unit. Exact replay returns its receipt with `duplicate:true` after renewed source/permission/identity/absence checks; its original unit and target must still match, and the goal must remain the exact post-rebind record. The receipt's `hadRebindings` preserves whether the pre-request goal contained that field when reconstructing its exact original digest. A superseded adoption/rebind, changed request/id binding or stale snapshot cannot regain custody. Capture a fresh request for subsequent changes; do not edit records.

After recovery, ordinary finish uses the new observed owner in `parentRuntime` and retains the existing user process with closable=false. Actual result delivery, goal completion and managed reviewer closure continue to require their normal evidence. Rebind creates no session input, start, close or fabricated task/enforcement receipt.

## Externally closed retained stopped owner

`unit stopped-owner-recover <unit> --request recovery.json --user-input <actual-user-input-ref>` records the independently verified external closure of an owner retained by recipient-free `session-stop`. Use the original project/state roots and trusted adapter module. It requires the original change unit in Stopped, its current blocked goal, a matching immutable stopReport and settled reviewers/effects. An unregistered reviewer that never started can first be settled through [public session-start recovery](session-policy-recovery.md); its source-bound terminal non-start observation replaces no review verdict or close receipt. It does not close any process, resume work, change execution policy or rewrite the Unit Record.

The request contains exactly the adoption request fields above plus `ledgerDigest` and `custodyDigest`. `owner` identifies the exact historical owner, not the caller or proposed replacement. `custodyDigest` hashes the complete current `goalOwner(goal,unit)` receipt. `ledgerDigest` hashes the complete parsed ledger row array under its lock. Other digests bind the complete current stopped unit, blocked goal and trusted inspected Git target. Historical managed custody without a full native owner requires the trusted verifier to establish the exact process/thread identity from original launch evidence. A copied identity or caller-supplied absence assertion is insufficient.

The trusted provider implements `verifyUserInput` with effect `unit.stopped-owner.recover` and read-only `verifyStoppedOwnerRecovery`. Both bind `{unit,goalId,userInputRef,argsDigest,unitDigest,goalDigest,ledgerDigest,targetDigest,custodyDigest,ownerDigest,policyDigest}`; user-input verification additionally receives `effect` and `reason`. The recovery verifier additionally receives clones of `{request,record,goal,target,custody}`. Each returns `verified:true` and all scalar bindings unchanged only after verifying actual sourced authority for both the exact external closure and same-unit recovery, provenance bytes, historical native identity, current source/target and execution policy. Operational handoffs, request files and absence alone do not grant authority. Compose these trusted verifiers with the packaged session observer and Git provider; never register an unconditional success callback.

`session.observe({closedOwner,cwd})` independently returns `{closed:true,owner:closedOwner}` only after complete native terminal inventories and OS PID listings establish absence twice. The exact surface/terminal and PID must both be absent; reused IDs/PIDs, malformed or ambiguous inventory, live processes and failed observations reject recovery. The observer performs no close or launch effect. Core verification repeats native observation, immutable source/stop-packet/blocker-failure checks and full target inspection before committing under ledger → unit → goal locks.

The goal appends one `stoppedOwnerRecoveries` observation with the original request/bindings, blocker and retired custody digests. All unit bytes, stop reports, custody receipts, failures, effects and prior recovery observations remain intact. Exact replay revalidates the original preimage and returns `duplicate:true` while the goal is still the exact post-recovery blocked record. A changed ID/payload, later state, new target or conflicting concurrent request cannot retire custody again. No `session.close` intent, result or closeReceipt is fabricated.

Continue with ordinary `goal resume` at the new goal revision and then `unit resume` with its normal snapshot. Both use the same trusted adapters and revalidate closure, authority, target, source and ledger. Unit resume archives the observation and original stop report in `sessionHistory` and returns to `stoppedFrom`, preserving the original unit and all failure history. Start the same unit with ordinary `unit session-start` and a verified live supervisor in `parentRuntime`. The next attempt is distinct; exact/concurrent starts reuse one effect. Current-owner selection excludes the retired custody generation and selects the new verified bootstrap. Historic custody remains readable. Recovery is not a task-start or result-delivery receipt and does not relax independent review or finish requirements.

When persisted evidence requires `rerun-gate`, or accepted content requires `revalidate`, an eligible undelivered change unit resumes through its recorded SelfGated/InReview/Accepted origin into SelfGated. The public resume result has code 0 and stage `gates` while retaining the recovery decision. The driver verifies complete persisted evidence fingerprints and tracker consistency before mutation and repeats the same stopped-owner authority and closure checks under lock. `resumeRevalidations` preserves prior acceptance and review; original evidence remains and stale invalidations append with no coverage. Run ordinary `unit accept` to execute current mandatory gates and obtain a new independent review under the existing policy. A missing fingerprint, unknown checkpoint, unresolved effect, conflicting delivery/finalization or unsupported lifecycle state does not enable this transition. Scoped and Implementing origins instead resume their unfinished stage with invalidated evidence and reach mandatory gates through ordinary stage submission. Independent `evidence rerun` continues to require identical inputs.
