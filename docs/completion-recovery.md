# 완료 예약과 전달 후 재작업 복구

완료 예약은 목표의 현재 단위와 수용 내용, 결과 전달 계획을 결속한다. 예약이 있으면 결과를 기록하고 목표 완료를 확정할 때까지 다른 목표 전이는 차단된다. 같은 완료 요청이 중단된 경우 원래 요청으로 재시도하거나, 단위가 이미 `Closed`면 `goal reconcile <goal>`을 실행한다.

## 완료 예약 뒤 대상이 바뀐 경우

`unit completion-recover <unit> --request <file> --user-input <ref> --adapters <module>`은 기존 owner 종료가 적용되지 않았고 이전 실행이 다시 종료할 수 없음을 신뢰된 호스트가 증명할 때에만 예약을 해제한다. 입력은 다음 객체다.

```json
{
  "id": "<고유 복구 ID>",
  "expectedRevision": 1,
  "expectedGoalRevision": 2,
  "reservationDigest": "sha256:<현재 completionReservation의 effectArgsDigest>",
  "targetDigest": "sha256:<현재 git.inspectUnit 결과의 effectArgsDigest>",
  "provenance": { "path": "<증거 파일 절대 경로>", "digest": "sha256:<파일 내용 해시>" },
  "reason": "<복구 이유>"
}
```

제공자는 `verifyGoalCompletionRecovery`에서 요청·목표·단위·대상·원 close intent와 사용자 입력의 결속을 재확인하고, `closeNotApplied`, `oldExecutionFenced`, `ownerAlive`, `queueSettled`를 각각 독립적으로 증명하고 원 owner의 `sessionId`, `incarnationId`, `cwd`를 반환해야 한다. 프로세스 부재, 큐에 보이는 메시지의 부재, 구버전이 무시하는 원장 표식만으로 미래 실행을 차단했다고 판단하지 않는다. 증명이 없거나 종료가 이미 적용됐다면 이 명령은 복구하지 않는다.

복구는 기존 수용·전달·결과와 종료 계획을 보관하고 해당 close intent를 폐기하며, 단위를 `SelfGated`로 되돌리고 이전 검증과 리뷰를 무효화한다. 이후 현재 대상에 맞춰 검증·리뷰·수용과 필요한 전달을 다시 수행한다. 중단 후에는 같은 입력과 복구 ID로 재실행한다. 수동으로 예약이나 원장을 지우지 않는다.

## 전달 후 추가로 승인된 수정

`unit rework <unit> --request <file> --user-input <ref> --adapters <module>`은 전달된 단위의 원 결과 전달 intent가 미해결인 경우에만 재진입한다. 요청에는 고유 ID, 단위·목표의 예상 revision, 원 intent의 `seq`, `key`, 인자 digest, 증거 파일 경로와 digest, 기존 기준을 유지한 전체 `acceptance` 목록 및 이유를 포함한다. 호스트 `verifyDeliveredRework`는 기존 결과 전달·종료 실행이 더 이상 수행되지 않음과 실제 전달, owner 및 큐 상태를 증명해야 한다. 기존 수용 기준과 전달 의무, 적용된 전달과 증거는 보존된다. 새 수정은 다시 검증·리뷰·수용하고 전달한다.

예약 후 Git HEAD가 변경돼 `unit stage open`이 `CHECKPOINT_STALE`을 반환하면 기존 완료된 implement attempt와 현재 후손 HEAD로 `unit stage restart`를 먼저 실행한다. 범위 검사는 재작업 단계 제출 시 수행되며, 범위 밖 변경은 수용을 막는다.

재작업 도중 `GOAL_REWORKING`이 나오면 같은 요청과 어댑터로 `unit rework`를 재실행한다. 예약은 원장과 단위 기록이 모두 보존된 후 해제되며 다른 목표 변경은 그때 진행한다.
