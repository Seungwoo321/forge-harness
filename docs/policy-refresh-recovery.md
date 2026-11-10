# 잘못 적용된 실행 정책 갱신 복구

공개 `goal policy-recover`는 잘못된 승인 출처로 이미 적용된 마지막 정책 갱신의 **정확한 직전 정책**을 복원한다. 원 `policyChanges` 행·잘못된 출처·목표 정의·custody·불변 패킷·단계·실패·증거·원장·전달 이력은 유지한다. 다른 정책을 지정하거나 원 행의 출처만 바꾸는 명령이 아니다. 공유 정책을 수정하지 않고 worker를 기동·등록·재시작·종료하지 않는다.

현재 목표의 첫 remaining 단위가 SelfGated/InReview/Accepted의 제출된 미전달 변경 단위이고, 기존 native 소유자의 custody가 직전 정책의 원 digest를 결속해야 한다. 진행 중 단계, 전달·종료 계획, 불확실한 효과와 해당 단위의 리뷰 등록·기동 이력은 거부한다. 실제 이전 정책의 허용을 입증할 수 없으면 복구하지 않는다.

## 요청과 실행

현재 목표는 `goal show`, 단위 revision은 `unit progress`로 확인한다. 전체 객체 digest는 `scripts/lib/approvals.mjs`의 `effectArgsDigest`, 파일 digest는 원 바이트 SHA-256이다. 신뢰된 호스트가 공개 명령의 현재 목표와 단위 읽기에서 전체 결속을 준비한다. 요청에는 아래 필드만 둔다.

```json
{
  "id": "restore-authorized-policy",
  "unit": "change",
  "expectedRevision": 14,
  "expectedUnitRevision": 23,
  "goalDigest": "sha256:<current complete goal>",
  "unitDigest": "sha256:<current complete unit>",
  "targetDigest": "sha256:<live git inspectUnit result>",
  "changeRevision": 14,
  "changeDigest": "sha256:<exact last policyChanges row>",
  "owner": {
    "runtime": "cmux",
    "sessionId": "native-owner",
    "incarnationId": "native-incarnation",
    "cwd": "/absolute/project",
    "worker": {
      "executable": "/absolute/bin/codex",
      "pid": 42,
      "threadId": "native-thread",
      "incarnationId": "worker-incarnation"
    }
  },
  "provenance": {
    "path": "/absolute/original-authority-proof.json",
    "digest": "sha256:<immutable proof bytes>"
  },
  "reason": "Restore the independently authorized prior execution policy"
}
```

정확한 기존 소유자 cwd에서 같은 명시 roots와 신뢰된 어댑터를 사용한다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" goal policy-recover goal --request recovery.json --user-input '<actual original human instruction>' --adapters runtime.mjs --project-root /absolute/project --state-root /absolute/state
```

성공은 `receipt`를 반환하고 목표 revision을 하나 증가시킨다. `policyRecoveries`는 원 요청·실제 원문 권한·현재 정책·복원 정책 digest·검증 증명을 보존한다. `policyChanges`에는 잘못된 행을 `supersedesRevision`으로 가리키는 새 `recoveryId` 행을 추가한다. 이전 갱신이 승인됐다는 뜻으로 읽지 않는다.

같은 ID와 입력의 재호출은 전체 복구 직후 목표·원 단위·현재 대상·출처·native 소유자·권한을 재검증한 경우에만 읽기 전용 duplicate를 반환한다. 이후 목표/단위 변경·후속 복구·리뷰 등록은 오래된 재호출을 거부한다. 같은 ID의 다른 입력은 conflict다. 현재 snapshot이 달라지면 과거 revision을 반복하거나 정본 파일을 편집하지 않는다.

## 신뢰된 호스트 계약

`provider.verifyUserInput`은 scalar binding 전체와 `effect:'goal.policy.recover'`, `reason`을 검증한다. `provider.verifyPolicyRefreshRecovery`는 같은 binding과 `request`, 복구 전 `goal`, `record`, 실측 Git `target`, native `observation`, 원 `custody`, 잘못된 `change`를 받는다.

| Binding | 결속 |
| --- | --- |
| `goalId`, `unit`, `userInputRef` | 정확한 목표·현재 단위·실제 원 사람 입력 |
| `argsDigest` | `{request,userInputRef}` |
| `goalDigest`, `unitDigest`, `targetDigest`, `changeDigest` | 원 요청에 고정된 전체 목표·단위·실측 대상·마지막 갱신 행 |
| `ownerDigest`, `custodyDigest` | 정확한 native 신원·원 custody 전체 |
| `sourceDigest`, `provenanceDigest` | 목표 정본·불변 증명 원 바이트 |
| `restoredPolicyDigest`, `rejectedPolicyDigest` | 마지막 행의 previous·잘못 적용된 현재 정책 |
| `rejectedUserInputRef` | 보존할 원 갱신의 잘못된 출처 |

제공자는 읽기 전용으로 원 사람 메시지와 당시 차단/인계 문맥을 실제 신뢰된 reader로 읽는다. 운영 relay·요청자 주장·파일의 boolean·단순 메시지 존재를 권한으로 인정하지 않는다. 해당 원문이 잘못 적용된 현재 정책을 승인하지 않았으며, 직전 정책의 계정·모델·effort·argv·모든 role을 실제로 허용함을 독립 검증한다. 조건부 fallback이면 당시 조건 충족 근거도 확인한다. 원 소유자의 실제 native 계정과 실행 설정을 직전 정책으로 검증한다. 원문을 잘못 적용된 정책의 승인으로 재해석하지 않는다.

반환은 binding 전체와 `verified:true`, `originalAuthority:true`, `currentPolicyUnauthorized:true`, `priorPolicyAuthorized:true`, `nativeExecutionVerified:true`, `evidenceDigest:request.provenance.digest`를 포함한다. 원문·조건·native 계정/설정을 검증할 수 없거나 결속이 다르면 성공을 반환하지 않는다. 패키지 기본 어댑터는 권한을 추측하지 않으며 전용 제공자가 없으면 거부한다.

엔진은 원장→단위→목표 잠금 안에서 출처·대상·native 소유자·리뷰 부재를 검증 전후 확인한다. 목표에 결속된 새 단위 등록은 해당 단위 원장→리뷰 대상 단위→목표 잠금을 생성까지 유지하고 최초 목표·출처·대상을 다시 확인해 지연된 등록이 오래된 리뷰 ID를 남기지 않는다. 새 기존 소유자 리뷰 기동은 같은 잠금에서 현재 goal 실행정책을 재검증해 동시 등록된 오래된 설정의 기동을 거부한다. 복구 후 리뷰는 그대로 유지된 원 목표 정책과 동등한 설정으로 정상 공개 등록·기동 절차를 따른다.

빈 `session.roles:{}`와 생략된 roles는 의미 비교에서 동등하다. 빈 map은 상속된 role override를 제거할 수 있지만 영속 goal이나 공유 정책을 정규화하지 않는다. 비어 있지 않은 role map과 실제 실행 설정 차이는 계속 거부하며 원 custody/effect digest도 유지한다. 근거: [ADR 0033](adr/0033-policy-refresh-authority-recovery.md).
