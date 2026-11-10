# 실행 정책 변경 뒤 미확정 기동 복구

일반 `unit session-start` 재호출은 같은 단위·role·attempt의 원 intent에 저장된 전체 인자와 불변 snapshot을 사용한다. 현재 목표의 실행 정책이 바뀌어도 원 수신자의 영수증을 원 계정·런타임으로 검증한다. 원 목표 정의·출처·인계·리뷰 대상 변경은 거부한다. `waitSeconds`와 관찰용 부모 신원은 effect 인자가 아니며 실제 부모 검증은 유지한다. 같은 roots와 `--adapters`를 사용한다.

재관찰로 성공 영수증이 확인되면 기존 attempt를 등록한다. 미확정 상태나 인증 오류, 빈 화면, cleared goal, 깨끗한 Git 트리, 영수증 부재만으로 다른 worker를 시작하지 않는다. 시작·대기 중인 작업을 먼저 취소하거나 종료하는 권한을 이 명령이 부여하지 않는다.

## 공개 예약 경로

사용자가 실행 정책 변경과 같은 단위 재개를 정확히 승인했고 원 작업이 실제로 미착수였다는 신뢰된 증명이 있으면 `unit session-recover`로 다음 attempt를 예약한다. 원 영수증이 성공했거나 단위·목표에 소유자가 등록돼 있으면 거부한다. 원 수신자와 대기 작업이 영구적으로 실행 불가능해야 한다. 살아 있는 Ready 세션은 이 복구의 증거가 아니다.

요청은 다음 필드만 포함한다. digest는 `scripts/lib/approvals.mjs`의 `effectArgsDigest`로 해당 전체 객체를 계산한다. 파일 digest는 원 바이트의 SHA-256이다. 현재 단위 revision은 `unit progress`로, 목표 revision은 `goal show`로 확인한다. 원 intent 참조는 같은 session-start를 재관찰한 `RESULT.result.intent`의 `key`·`seq`·`argsDigest`를 사용한다. 원장을 직접 읽거나 수정할 필요가 없다.

```json
{
  "id": "startup-recovery-1",
  "expectedRevision": 4,
  "expectedGoalRevision": 3,
  "intent": {
    "key": "sha256:<original effect key>",
    "seq": 1,
    "argsDigest": "sha256:<digest of original complete args>"
  },
  "provenance": {
    "path": "/absolute/native-non-start-proof.json",
    "digest": "sha256:<original proof file bytes>"
  },
  "reason": "Explicitly authorized restart under the refreshed execution policy"
}
```

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit session-recover change --request recovery.json --user-input '<actual verified instruction>' --adapters runtime.mjs
node "$PLUGIN_ROOT/scripts/unit.mjs" unit session-start change --request original-start.json --adapters runtime.mjs
```

예약은 worker를 기동하지 않는다. 성공한 예약은 `receipt.nextArgs`·`nextKey`를 반환한다. 이어지는 session-start는 예약한 불변 snapshot과 원 cwd·인계 경로·digest를 사용한다. 부모 런타임이 바뀌면 실제 새 부모 신원을 start 요청에 지정하고 소유자 검증을 통과한다. 같은 예약 ID·입력의 재호출은 기존 예약을 반환한다. 다른 입력으로 ID를 재사용하면 거부한다. 예약 직후 프로세스가 중단돼도 같은 명령으로 재개한다.

원장에는 `session-start-recovery` 행을 추가한다. 이 행은 원 intent digest·승인·증명·다음 인자를 결속한다. 원 intent·submission·confirmation·실패·증거는 유지하며 원 효과의 성공 또는 not-applied result를 만들지 않는다. 폐기된 원 key는 일반 효과 실행에서도 재관찰·재기동하지 않는다. 완료·재개 판단은 검증된 폐기를 미해결 효과와 구분한다.

## 신뢰된 제공자 계약

런타임 모듈의 `provider.verifyUserInput`은 아래 scalar binding 전체와 `effect: 'unit.session.recover'`, `reason`을 받아 같은 값과 `verified:true`를 반환한다. 실제 사용자 입력이 해당 원 시도·새 정책·단위·증명에 대한 재개를 승인했는지 확인한다. 요청 파일의 주장을 승인으로 반사하지 않는다.

`provider.verifySessionStartRecovery`는 같은 binding과 `request`, 원 `intent`, 원 `submission`(미제출이면 null), 원 snapshot `original`, 현재 `goal`, 예약할 `nextArgs`를 받는다.

| Binding 필드 | 결속 대상 |
| --- | --- |
| `unit`, `goalId`, `userInputRef` | 실제 단위·목표·사용자 입력 |
| `argsDigest` | `{request,userInputRef}` |
| `intentDigest`, `submissionDigest` | 원 intent 및 submission 전체 객체; 미제출은 null |
| `unitDigest`, `goalDigest` | 잠금 안의 현재 단위·목표 전체 객체 |
| `nextArgsDigest` | 다음 session.start 전체 인자 |
| `provenanceDigest` | 원 증명 파일 바이트 |

제공자는 읽기 전용으로 다음을 검증하고 binding 전체와 `verified:true`, `taskNeverStarted:true`, `receiverStopped:true`, `queueCancelled:true`, `evidenceDigest:request.provenance.digest`, `receiver`를 반환한다. `receiver`에는 `runtime`, `sessionId`, `incarnationId`, `cwd`, `threadId`, `pid`, `executable`이 필요하다. 제출 기록이 있으면 모든 신원이 원 binding과 일치한다. 미제출 intent도 원 관리 기동과 정확한 수신자의 관계를 native 근거로 검증한다.

- `original.policy`의 **원 계정과 원 런타임**에서 원 요청의 전체 이력과 실제 queue를 확인한다. 현재 계정의 빈 이력을 대신 사용하지 않는다.
- 원 목표 입력을 받은 이후 실제 assistant 응답·도구 실행이 없었고, 이미 성공한 작업도 없음을 증명한다. 인증 실패와 goal clear만으로 미착수를 추정하지 않는다.
- 원 수신자의 정확한 incarnation이 종료됐고 원 요청·큐가 취소되어 지연 실행할 수 없음을 증명한다. 재사용된 surface·PID·thread·새 incarnation을 원 수신자로 취급하지 않는다.
- 증명 파일의 출처와 digest를 검증한다. 요청자가 쓴 boolean, 스크린샷, 조회 실패를 native 증명으로 인정하지 않는다. 새 입력·goal clear·취소·프로세스 종료는 이 읽기 전용 검증 안에서 수행하지 않는다.

선택적 session verifier가 원 영수증을 발견하면 예약을 거부한다. verifier에는 `submission.readOnly:true`가 전달되며 입력을 제출하지 않는다. 원 native 환경을 읽을 수 없거나 영구적인 미실행을 증명할 수 없으면 예약하지 않는다. 패키지 기본 세션 어댑터는 이러한 권한 검증을 임의로 제공하지 않으므로 호스트 제공자가 없으면 차단한다.

기동과 예약은 원장→단위→기존 사용자 소유 리뷰 대상→목표 순서로 잠근다. 목표 정책 변경은 같은 목표 잠금과 경합하며 진행 중 기동을 덮지 않는다. 기존 사용자 소유자의 리뷰에서는 기동 시 실제 소유자와 Git 대상을 계속 재검증한다. 근거: [ADR 0030](adr/0030-session-policy-recovery.md), [네이티브 제출 경계](native-goal-recovery.md).
