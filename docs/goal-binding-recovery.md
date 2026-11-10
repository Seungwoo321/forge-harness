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
