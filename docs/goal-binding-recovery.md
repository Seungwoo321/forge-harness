# 기존 단위의 승인 출처와 goal 결속 복구

원 작업의 계속 지시는 직전의 미완료 보고와 함께 해석한다. 알려진 하네스 차단을 보고받은 사용자의 계속 지시는 정책이 허용하는 필수 최소 수리를 포함할 수 있다. 제품 범위 확대·외부 권한·상태 초기화까지 허용하는 지시로 해석하지 않는다. 메시지가 `user.text`라는 사실만으로 운영자 전달문을 원래 사람 승인으로 취급하지 않는다.

## 잘못 기록된 범위 승인

`unit scope approval-correct <unit> --request <file> --user-input <original-human-ref> --adapters <module>`은 같은 범위를 원 대화의 실제 권한으로 재검증한다. 미수용 Implementing/SelfGated/InReview 변경 단위만 허용하며 원 scopeAmendments 행과 모든 단계·실패·게이트·리뷰는 그대로 둔다. 요청은 다음 필드만 가진다.

```json
{"id":"scope-source-1","expectedRevision":19,"amendment":{"index":0,"digest":"sha256:<canonical digest of the whole original amendment>"},"reason":"Original human continuation after the documented prerequisite blocker"}
```

구조 digest는 `effectArgsDigest`를 사용한다. 신뢰된 `provider.verifyUserInput`은 `unit`, `userInputRef`, `effect:'unit.scope.approval.correct'`, `argsDigest`(`{request,userInputRef}`), 현재 `unitDigest`, 원 `amendmentDigest`, `previousUserInputRef`, 실측 `targetDigest`, `reason`을 받는다. 원 대화의 실제 사람 메시지와 직전 보고·적용 정책을 읽어 정확히 같은 작업·범위의 권한을 확인한 뒤 같은 필드와 `verified:true`를 반환한다. 전달된 운영 문구나 요청 JSON을 승인으로 반사하지 않는다. 새 범위·기준·정책을 함께 바꾸지 않는다.

제어면은 원장·단위 잠금 아래 승인과 현재 대상을 다시 확인하고 `scopeApprovalCorrections`에 원 행 전체, 실제 사용자 참조, 요청 digest와 revision을 추가한다. 같은 id/입력은 기존 영수증을 반환하고 변경 payload·원 행·대상·revision·미해결 효과는 거부한다. 원 행의 오류가 없었던 것으로 바뀌지 않으며 새 승인 출처가 별도 감사 기록으로 남는다. 기존 additive `scope amend`의 동일 경로 no-op는 승인 출처 정정을 뜻하지 않는다.

## 이미 수용된 미결속 단위

일반 `goal-bind`의 미착수 조건은 유지한다. 같은 명령에 다음 명시적 복구 요청과 실제 사용자 입력을 전달한다.

```json
{
  "recover":true,
  "id":"missing-goal-1",
  "goalId":"original-work",
  "expectedRevision":25,
  "expectedGoalRevision":1,
  "unitDigest":"sha256:<current complete unit>",
  "goalDigest":"sha256:<current complete goal>",
  "targetDigest":"sha256:<live Git inspection>",
  "reason":"Original task requires its missing initial goal binding"
}
```

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit goal-bind change --request binding.json --user-input '<original-human-ref>' --adapters runtime.mjs
```

goal은 기존 공개 정책·goal 등록 명령으로 먼저 등록한다. 사용자에게 승인된 실제 실행 설정을 사용하고 과거 단위에 session 정책이 없었다는 사실을 보존한다. 기본 계정·모델·권한을 만들어 넣지 않는다.

복구는 미결속·continuityRequired·미전달 Accepted 변경 단위에만 적용한다. 완료 단계·필수 게이트·수용 기준·독립 리뷰와 현재 Accepted 대상을 검증한다. 등록된 native 소유권, 기존 session 효과 이력, 미해결 효과, 진행 중 단계·전달·종료 계획, 이미 다른 goal에 결속된 단위는 거부한다. 현재 active goal의 첫 남은 단위여야 하며 source 파일 바이트가 저장 digest와 같아야 한다.

`verifyUserInput`은 `effect:'unit.goal.bind.recover'`, `unit`, `goalId`, `userInputRef`, `argsDigest`(`{request,userInputRef}`), `unitDigest`, `goalDigest`, `targetDigest`, `sourceDigest`, `originalRequestDigest`, `policyDigest`, `reason` 전체를 검증한다. 원 실제 사람 지시·차단 문맥·원 요청과 새 goal의 관계·실행 정책이 정확히 허용되는지 확인한다. 같은 필드와 `verified:true`만으로 성공하며 검증 부재는 차단한다.

원장→단위→goal 잠금을 얻고 goal 잠금을 단위 파일의 원자적 commit이 끝날 때까지 유지한다. `goalBindings`에 원 요청·정책과 새 결속·승인 영수증을 추가하며 Unit Record의 goal 메타데이터만 연결한다. goal 자체와 원 단계·실패·원장·증거·수용·리뷰는 바꾸지 않는다. 동일 요청 재호출은 revision을 늘리지 않고 기존 영수증을 반환한다.

결속은 native 소유권이 아니다. 이어 기존 `session-adopt`로 실제 소유자·계정·출처·대상을 검증하고, 같은 단위의 정상 acceptance/finish를 사용한다. task/enforcement/transfer/close 영수증을 합성하지 않는다. source나 권한·native 관찰·전달 어댑터가 없으면 해당 공개 경계에서 중단한다. 이 복구는 delivery 정책을 낮추거나 게이트를 지우지 않는다.

설계 근거: [ADR 0029](adr/0029-recover-missing-goal-binding.md).

## 초기 기준 결속과 동일 단위 명확화

목표에 연결된 scope의 `done` 제출은 구현 전에 AC와 원 목표의 정확한 문구 결속을 검사한다. 마지막 남은 단위는 현재 AC와 검증된 완료 선행 단위로 모든 목표 기준을 보존한다. 앞선 단위는 적어도 하나의 원 기준을 정확히 결속하고 남은 기준은 후속 단위에 남긴다. 추가 제품 AC는 그대로 검사하며, 문구의 의미가 비슷하다는 추측으로 결속하지 않는다.

이미 Accepted인 원 단위의 기록 불일치는 `unit goal-acceptance clarify <unit> --request <file> --user-input <original-human-ref>`로 명확화한다. Stopped-from-Accepted도 지원하지만 중단 상태·실패·소유자는 바꾸지 않는다. 정상 goal/unit resume은 별도다. 요청은 다음 필드만 가진다.

```json
{
  "id":"original-mapping-1",
  "expectedRevision":25,
  "expectedGoalRevision":8,
  "unitDigest":"sha256:<whole current unit>",
  "goalDigest":"sha256:<whole current goal>",
  "targetDigest":"sha256:<live Git inspection>",
  "mappings":[{"criterion":"Unchanged original goal criterion","acceptanceRefs":["AC-1","AC-2"],"evidence":[{"ref":"actual-result-reference","digest":"sha256:<actual result bytes>"}]}],
  "provenance":{"ref":"original-source-reference","digest":"sha256:<source bytes>"},
  "reason":"Original source establishes the full retained obligation"
}
```

모든 원 목표 기준은 한 번씩 명시하며 각 AC 참조는 기존의 활성 AC여야 한다. 각 매핑은 실제 결과 증거의 ref/digest 목록도 필수로 보유한다. 목표·AC·정정된 관찰/전달 분류·수용 대상·전체 게이트·리뷰·실패·재시도·정책·native custody는 변경하지 않는다. 다른 목표, 축소된 기준, 누락·중복·외래·보류·제외된 참조, 진행 중 리뷰/단계/효과, 미검증 대상·증거·소유자는 거부한다.

신뢰된 `provider.verifyUserInput`과 읽기 전용 `provider.verifyGoalAcceptanceClarification`을 모두 요구한다. 두 검증기는 `unit`, `goalId`, `userInputRef`, `effect:'unit.goal-acceptance.clarify'`, `argsDigest`(`{request,userInputRef}`), `sourceDigest`, `definitionDigest`, `basisDigest`, 현재 `targetDigest`, `unitDigest`, `goalDigest`, `custodyDigest`를 받는다. 후자는 추가로 `request`, `record`, `goal`, `target`의 구조 사본을 받는다. 현재 상태의 모든 scalar binding과 `verified:true`를 반환해야 한다. 단순 요청 반사는 검증이 아니다.

검증기는 실제 사람 원 지시와 출처 바이트·원래 목표의 모든 절·AC·원 게이트/리뷰·외부 전달 요구를 읽고 매핑이 의무를 줄이지 않는지 확인한다. 원 목표에만 기록된 외부 관찰·전달·설치·원 명령 재개의 실제 수행은 매핑의 별도 결과 증거를 현재 수용 대상과 결속해 확인한다. AC가 권한 전제만 설명하거나 제품 테스트가 통과했다는 사실은 원 외부 의무의 수행 증거가 아니다. 원 기준의 어느 절이라도 실제 결과로 입증하지 못하면 명확화를 거부한다. 전달 소유자와 요구 수준은 그대로 유지하고, 외부 소유 전달의 실제 수행은 기존 `verifyExternalDelivery`가 수용 대상과 결속해 finish/finalization에서 다시 증명한다. 명확화는 실행·배포 권한이 아니다.

명확화는 원장→단위→goal 잠금 아래 단위의 `goalAcceptanceClarifications`에 한 영수증만 원자적으로 추가한다. goal은 쓰지 않는다. 정확한 재호출은 기존 영수증을 반환하며 다른 payload는 거부한다. 실제 프로세스 종료 뒤에는 이 명령의 동일 요청 digest로 표시된 죽은 잠금만 native 직렬화 아래 회수한다. 살아 있거나 모호한 PID, 다른 요청, legacy/native fence 잠금은 삭제하지 않는다. 원 단위의 실패와 재시도 카운터는 초기화하지 않는다.

완료 proof는 명확화된 기준에 `{criterion,unit,acceptances:["AC-1","AC-2"]}`를 사용하며 목록과 순서가 감사된 매핑과 같아야 한다. 기존 정확한 문구 경로는 `{criterion,unit,acceptance:"AC-1"}`를 유지한다. 원 목표 정의나 수용 의무·게이트·리뷰가 달라지면 영수증은 stale이다. 기존 전달 binder가 같은 검증 부모와 내용의 commit을 결속하는 경우만 Git 메타데이터의 정상 전진을 허용하며 원 수용 사본을 영수증에 보존한다. finish와 전달/종료 경계는 출처·신뢰 검증기·현재 native 소유자와 외부 전달을 다시 확인한다.

설계 근거: [ADR 0042](adr/0042-goal-acceptance-binding.md).

### 살아 있는 retained 중단 소유자의 계속

recipient 없는 `session-stop`으로 Stopped-from-Accepted가 된 원 소유자가 여전히 살아 있으면, 기존 종료 관찰 경로를 사용하지 않는다. 먼저 위 명확화를 기록하고 아래의 명시적 요청으로 `goal resume <goal> --request <file> --user-input <original-human-ref>`를 실행한다.

```json
{
  "id":"retained-binding-1",
  "expectedRevision":8,
  "unit":"change",
  "unitDigest":"sha256:<whole current stopped unit after clarification>",
  "goalDigest":"sha256:<whole blocked goal>",
  "ledgerDigest":"sha256:<complete current ledger rows>",
  "targetDigest":"sha256:<live accepted target>",
  "custodyDigest":"sha256:<original retained custody>",
  "clarification":{"id":"original-mapping-1","digest":"sha256:<whole clarification receipt>"},
  "resolutionEvidence":{"ref":"actual-resolution-reference","digest":"sha256:<resolution bytes>"},
  "reason":"Continue the same live owner after the binding-only blocker is resolved"
}
```

`verifyUserInput`과 별도의 읽기 전용 `verifyGoalAcceptanceResume`은 실제 원 사람 지시가 같은 살아 있는 소유자의 계속을 허용하며, 원 blocker가 명확화로 해결된 결속 불일치만인지 검증한다. 입력은 `unit`, `goalId`, `userInputRef`, `effect:'goal.resume.retained-clarification'`, `argsDigest`(`{request,userInputRef}`), `unitDigest`, `goalDigest`, `ledgerDigest`, `targetDigest`, `custodyDigest`, `clarificationDigest`, `stopReportDigest`, `failureDigest`, `policyDigest`다. 후자는 `request`, `record`, `goal`, `target`, 원 `failure` 사본도 받는다. 정확한 scalar binding과 `verified:true`, `bindingOnly:true`를 반환해야 한다. 매핑 권한만으로 재개 권한을 추정하지 않는다.

원 user-domain/defer 실패와 원 불변 stop 패킷, 같은 blocked goal revision, 같은 Accepted 내용·게이트·리뷰·정책, 현재 같은 live custody, 끝난 리뷰 및 해결된 원장을 반복 검증한다. product 재시도, 다른 미해결 의무, 종료·변경·불명확한 소유자, 오래된 요청은 이 경로로 복구하지 않는다. 기존 `stopped-owner-recover`의 검증과 종료 조건은 그대로 유지한다.

goal만 먼저 active로 바꾸고 `retainedClarificationResumptions`와 blockerHistory에 감사 기록을 추가한다. 단위는 Stopped를 유지한다. 이 경계에서 크래시가 나면 같은 요청을 재실행하며 영수증은 한 번만 기록된다. 다음 `unit resume <unit> --snapshot <file>`은 현재 전체 Git/checkpoint/fingerprint 관찰과 감사 기록·원 권한·같은 native 소유자를 다시 검증한다. 입력이나 증거가 달라져 재검증이 필요하면 수용을 조용히 지우지 않고 거부한다. 변경 없는 원 Accepted만 복원하며 stopReport·실패·카운터·전체 원 증거를 유지하고 `sessionHistory`에 `retained-clarification` 관찰을 추가한다.

이제 같은 소유자가 기존 `unit finish`와 정확한 매핑 proof로 계속한다. `session-start`나 새 소유자 등록은 하지 않는다. finish/finalization의 원래 전달 권한·실제 외부 결과·독립 리뷰·정확한 소유자 종료 계약을 그대로 적용한다. 이 절차는 원 상태를 복제한 성공 주장이나 종료 영수증 합성을 허용하지 않는다. 공개 fail → goal block → recipient 없는 session-stop → clarify → 명시적 goal resume → unit resume → finish/finalize의 전체 회귀가 원 수용·stop 패킷·실패·custody 보존을 확인한다.

종료 응답이 끊긴 뒤 이미 닫힌 managed 소유자는 live로 재관찰하지 않는다. 같은 원장에 현재 finalization의 전체 close 인자와 key가 정확히 결속된 원 intent가 있을 때만, 읽기 전용 `session.verify`가 그 소유자의 실제 종료를 반복 확인한다. 이 경우 명확화 검증 binding은 `nativeClosureDigest`도 포함한다. 원 intent 없는 native 부재·다른 소유자·다른 결과/전달 key·미검증 종료는 완료 증거가 아니다. 실제 종료 영수증은 기존 효과 원장의 정상 reconcile이 기록하며 명확화 코드가 만들지 않는다.
