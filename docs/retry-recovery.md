# 상한 이후 근본 원인 복구

사용자가 명시한 `retry.onExhaustion: root-cause` 정책은 실패·재시도·해결 세션 카운터를 유지하며 같은 단위의 진단·수정·재검증을 허용한다. 생략하거나 `stop`이면 기존 상한을 적용한다. 정책 저장은 승인 참조를 요구하며 출처와 변경 이력을 보존한다.

진행 중이거나 중단된 미전달 단위에는 `unit policy change`로 정책을 적용한다. 요청은 `{id,expectedRevision,retry:{onExhaustion:"root-cause"},reason}`이고 실제 사용자 승인 참조를 `--user-input`으로 전달한다. 이 변경은 숫자 한도, 실패 이력, 증거, 원장과 소유권을 유지한다. 종료 보고나 세션 finalization이 있는 단위는 기존 소유권 복구 절차를 먼저 따른다.

## 격리된 제품 게이트

`unit accept`의 실패를 `unit fail <unit> --failure <file> --gate <id>`로 원 서명에 결속한다. 상한에 도달하면 원 실패의 `root-cause`를 제출하고 `unit retry <unit> --cause-key <key>`로 구현을 연다. 새 수정 제출 뒤 일반 acceptance가 실패 게이트부터 재검증한다.

보고서와 대상, 원 검증 명령, 허용 경로와 새 입력을 확인한다. 동일하거나 이전 입력을 거부한다. 실패가 남으면 이전 실패 사례 일부가 통과하고 새 실패가 없을 때 다음 진단을 허용한다. TAP 사례는 중첩 경로로 구별하며 skip·todo는 개선으로 세지 않는다. 보고서 변조, 불명확한 결과, 무진전은 다음 자동 복구를 막는다. 성공한 뒤에는 모든 필수 게이트와 원 정책의 독립 리뷰를 적용한다.

## 외부 수정의 검증과 동일 단위 재개

제품 또는 하네스 실패가 상한에 도달하면 원 실패 시점의 root-cause 입력을 읽고 진단을 먼저 제출한다. 원본 수정과 검증, 하네스의 공식 릴리스·설치 등 실제 복구 작업을 기존 승인 안에서 수행하고 증거를 보존한다. 다음 요청을 `unit retry <unit> --cause-key <key> --request <file>`에 전달한다.

```json
{
  "id": "verified-correction",
  "expectedRevision": 12,
  "failureId": "original-failure",
  "evidence": {"ref": "correction-report", "digest": "sha256:<원본 바이트 해시>"},
  "reason": "근본 원인 수정과 원 실패 재현의 성공을 검증"
}
```

신뢰 제공자가 실제 수정과 성공한 재검증을 확인해야 한다. 자기 신고만으로 진행하지 않는다. `resolved` 결과를 받으면 현재 Git·체크포인트·증거 fingerprint·tracker snapshot으로 기존 `unit resume`를 실행한다. 재개는 신뢰 증거를 다시 확인하고 수용·리뷰를 무효화하며 필수 게이트 재검증을 요구한다. 수정 전 원 단계가 scope나 implement면 그 단계를 마친 뒤 일반 acceptance로 간다.

`retryResolutions`, 원인 registry의 `continuations`, `retryResumptions`와 `resumeRevalidations`가 각 경계를 보존한다. 같은 요청은 동일 영수증을 반환한다. 같은 관찰로 다른 복구를 승인하거나 활성 해결 세션을 중복 기동할 수 없다. 효과의 intent만 있거나 결과가 unknown·uncertain이면 먼저 해당 효과를 관찰·확정한다.

## 캡처된 게이트 분류 정정

원 보고서가 제품 실패로 기록됐더라도 근거가 검증기 또는 환경 원인을 가리키면 root-cause는 `harness` 또는 `environment` 진단을 제출한다. 이 진단은 원 라벨과 원인 registry를 변경하지 않으며 제품 수정 경로를 열지 않는다. 위 `unit retry --request` 요청에 `classification`을 추가한다. 값은 제출한 진단과 일치해야 한다.

신뢰 제공자는 원 캡처 보고서와 실제 원인 분류, 수정, 원 실패 재현의 성공을 함께 확인한다. 하네스 수정이면 공식 배포·설치도 확인한다. 이 검증은 배포 권한을 부여하지 않는다. 자기 신고, 보고서만의 라벨 변경, 출처 없는 성공은 거부한다. 원 보고서 바이트와 실패, 카운터, 정책, 소유권은 보존한다.

`ordinary-diagnosis` 상태의 SelfGated 단위는 검증 뒤 같은 상태에서 모든 필수 게이트를 재실행한다. 중단된 단위는 기존 `unit resume`를 따른다. 첫 필수 게이트 재검증 완료 전에 제공자와 원 보고서를 다시 확인하며 기존 독립 리뷰 의무를 유지한다. `classificationRevalidations`에 검증 대상과 게이트 fingerprint를 보존한다. 이후 리뷰 수정은 기존 구현·수용 절차를 따르며 원 보고서·실패 바이트 검증은 계속한다. 수정된 검증기 입력은 실제 게이트 정의에 반영한다. 동일 입력에서 모순된 결과는 기존 비결정성 판정을 따른다.

## 신뢰 제공자 계약

런타임의 `provider.verifyRetryResolution(input)`은 읽기 전용이다. 입력은 `unit,failureId,causeKey,requestDigest,targetDigest,diagnosisDigest,policyDigest`와 `request,failure,diagnosis,policy,target,gateRecovery,previous`다. 구조 해시는 `effectArgsDigest`의 재귀적 키 정렬 JSON SHA-256이다.

분류 정정에서는 gateRecovery가 영수증에 보존된 원 캡처이며 request.classification은 정정할 분류다. 제공자는 원 요청의 정확한 증거 ref와 실제 바이트 digest, 원 실패와 진단, 인과관계가 있는 수정, 원 실패를 재현한 성공 결과, 현재 대상, 이전 복구 관찰을 대조한다. 하네스 수정이면 공식 배포·설치 경계를 함께 확인한다. 실행 여부 불명, 자기 신고, 오래된 성공, 다른 실패의 결과, 출처가 없는 보고서는 거부한다. 제공자는 상태를 쓰거나 효과를 실행하지 않는다.

성공 반환은 입력의 일곱 결속 필드를 같은 값으로 포함하고 `verified:true,resolved:true,progressDigest:"sha256:<독립 관찰 식별 해시>"`를 더한다. progressDigest는 실제 관찰 내용을 식별한다. 단위나 요청 ID만 바꿔 같은 관찰을 새 것으로 만들지 않는다. 스키마 결속, 원 실패 바이트, 정책, revision, 대상과 원장 확인은 코어가 반복하며 registry 잠금 안에서 재사용을 막는다.
