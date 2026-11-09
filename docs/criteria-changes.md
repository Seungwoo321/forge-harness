# 승인된 기준 제외

실제 사용자 지시가 이전 범위의 동작을 제외하면 같은 단위의 `unit acceptance drop`을 사용한다. 원 기준 원문을 삭제하거나 증거 분류를 바꾸는 명령이 아니다. decision resolve는 보류 기준을 open으로 돌릴 뿐이며, scope amend는 경로 추가, goal amend는 목표 변경만 소유한다.

## 공개 요청

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit acceptance drop "$UNIT" --request drop.json --user-input "$USER_INPUT_REF" --state-root "$STATE_ROOT" --project-root "$PRODUCT_ROOT" --adapters "$ADAPTER_MODULE"
```

요청의 정확한 키는 다음과 같다. `unit progress`가 revision, 기준별 criterionDigests, correctionSourceDigest, 저장된 대상 및 acceptanceAmendments를 반환한다. 실제 Git 대상은 제공자가 다시 관찰한다.

```json
{
  "id": "exclude-summary-1",
  "expectedRevision": 12,
  "acceptanceRef": "AC-2",
  "criterionDigest": "sha256:<원 기준 전체 객체 구조 해시>",
  "sourceDigest": "sha256:<원 요청·정본·전체 기준 구조 해시>",
  "head": "<현재 Git head>",
  "contentFingerprint": "<현재 검증 내용>",
  "provenance": {"ref":"<실제 사용자 제외 지시와 범위 변경 증거 참조>","digest":"sha256:<원본 바이트 해시>"},
  "reason": "사용자가 failure summary를 제외하고 fail-fast만 유지하도록 지시"
}
```

구조 해시는 effectArgsDigest의 재귀적 키 정렬 JSON SHA-256이다. source는 `{request: record.request, canon: record.canon ?? [], acceptance: record.acceptance ?? []}`이며 criterionDigest는 status를 포함한 원 기준 객체 전체다. provenance digest는 참조의 실제 원본 바이트 SHA-256이다. 같은 id/payload/userInputRef 재호출은 기존 영수증을 반환하고 다른 요청으로 id를 재사용하면 거부한다.

제출된 미수용 SelfGated 변경 단위만 허용한다. 진행 중 단계, 전달 계획/결과, 세션 finalization, 불확실한 효과, deferred/dropped 기준은 거부한다. Blocked/Stopped는 기존 공개 진단·재개 정책을 먼저 따른다. 이 명령은 재시도 예산을 초기화하거나 정책을 완화하지 않는다. 반환 RESULT의 `amendment`가 감사 영수증이다.

## 신뢰 제공자 계약

기존 provider에 읽기 전용 `verifyAcceptanceChange`를 구현한다. 환경별 실제 사용자 메시지·업무 정본 해석은 호스트가 소유한다. 코어에는 특정 업무 식별자나 세션 제공자 참조 형식을 넣지 않는다.

`verifyUserInput(input)`은 `{unit,userInputRef,operation:"drop",argsDigest,sourceDigest,head,contentFingerprint,targetDigest,effect:"unit.acceptance.drop",reason}`를 받는다. 실제 사용자 입력이 정확한 요청을 승인했는지 확인하고 모든 입력 필드를 같은 값으로 돌려주며 verified:true를 더한다.

`verifyAcceptanceChange(input)`의 전체 입력은 `{unit,userInputRef,operation:"drop",argsDigest,sourceDigest,head,contentFingerprint,targetDigest,request,source,target}`다. argsDigest는 `{request,userInputRef}`, targetDigest는 현재 inspectUnit 전체 객체의 구조 해시다. request/source/target은 복제된 준비 데이터이며 권한 증거 자체가 아니다.

성공 반환은 `{verified:true,unit,userInputRef,operation:"drop",argsDigest,sourceDigest,head,contentFingerprint,targetDigest}`다. 결속값 8개가 입력과 정확히 같아야 한다. 제공자는 실제 사용자 지시와 provenance 원본을 읽고 바이트 digest·출처·단위·정확한 원 기준·제외 범위를 독립 대조한다. 사용자가 제외하지 않은 제품 동작, 모호한 지시, 위조/오래된 출처, 다른 기준, 추가 정책/기준 변경은 거부한다. 입력 echo, 자기 신고 verified, 문자열에 drop이 있다는 사실은 승인 증거가 아니다. 검증 중 정본을 수정하거나 같은 단위 잠금을 획득하는 명령을 실행하지 않는다.

원 기준은 id/text를 유지하고 status만 dropped로 바뀐다. acceptanceAmendments는 request/userInputRef/requestDigest/beforeSource/before/after/previousReview/revision/changedAt를 추가 전용으로 보존한다. 기존 증거·실패·단계·정책·재시도와 분류 정정 역사는 보존한다. 이전 decision의 notify/resolve가 제외 기준을 되살리지 않으며 남은 결정은 자동 해소하지 않는다. 최신 게이트별 stale 행을 추가하고 수용/리뷰/diff/handoff를 비운다. 모든 게이트의 config.acceptanceScope는 현재 기준과 amendment 이력을 해시하며, 이전 epoch의 검사나 리뷰가 새 수용을 확정할 수 없다. 별도 review 단위도 제출 사전검사와 대상 잠금 안에서 입력의 전체 기준·분류 정정·범위 변경 이력을 현재 범위와 대조하고, 같은 Git head/내용이라도 옛 입력을 거부한다.

오류는 ACCEPTANCE_DROP_INVALID(형식/허용되지 않은 변경), ACCEPTANCE_DROP_STALE(revision/원문/source/대상), ACCEPTANCE_DROP_UNPROVEN(실제 제외 지시 미검증), ACCEPTANCE_DROP_CONFLICT(id 충돌), 기존 ADAPTER_MISSING/EFFECT_APPROVAL_REQUIRED/INVALID_TRANSITION/EFFECT_UNCERTAIN이다. 거부 시 단위 정본을 쓰지 않는다.

## 같은 단위 복구 순서

공식 수정 버전을 다운로드·공식 CLI로 갱신하고 태그/배포 commit/설치 내용과 필요한 제공자 계약을 확인한다. 설치 사본 수동 패치·정본 JSON 편집·대체 구현 단위는 사용하지 않는다.

원 목표가 제외 기준을 계속 요구하면 먼저 기존 `goal show`로 revision을 읽고 `goal amend "$GOAL" --request goal-amend.json --user-input "$USER_INPUT_REF"`를 실행한다. 요청은 `{expectedRevision,reason,objective,criteria:[남은 목표 기준의 정확한 원문]}`이며 실제 사용자 승인에 결속된다. 목표 변경만으로 단위 기준은 제외되지 않는다. 목표를 맞추지 않으면 나중의 목표 완료는 계속 거부된다.

원 제품 cwd에서 같은 roots/adapters를 유지한다.

```sh
repair_cli() { node "$PLUGIN_ROOT/scripts/unit.mjs" "$@" --state-root "$STATE_ROOT" --project-root "$PRODUCT_ROOT" --adapters "$ADAPTER_MODULE"; }
repair_cli unit progress "$UNIT"
repair_cli unit acceptance drop "$UNIT" --request drop.json --user-input "$USER_INPUT_REF"
repair_cli unit progress "$UNIT"
```

제외된 기준의 이전 분류 정정은 역사로 남고 활성 검증에서 빠진다. 다른 기존 observation/delivery 정정은 sourceDigest가 바뀌므로 각각 새 id·현재 revision/source/criterion digest·현재 증거와 기존 분류/owner/level을 유지하는 요청으로 갱신한다. 단위 이력을 읽어 필요한 것만 수행하고 매번 progress로 revision을 갱신한다.

```sh
repair_cli unit acceptance correct "$UNIT" --request retained-correction-refresh.json --user-input "$USER_INPUT_REF"
repair_cli unit accept "$UNIT"
```

accept는 새 범위 epoch의 필수 게이트와 남은 제품 기준을 검증한다. exit20이면 원 정책의 실제 독립 리뷰를 새 입력에 대해 수행하고 같은 `unit accept`를 재실행한다. 과거 ship을 복사하지 않는다. 남은 must-fix finding은 기존 공개 finding resolve의 독립 검증 없이 해소하지 않는다. 원 목표·미제외 기준·운영/전달 의무는 계속 유효하며 기존 finish/finalize를 사용한다. 외부 전달은 원 delivery:none을 유지한다.
