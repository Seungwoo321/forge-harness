# 동일 단위 검증 정정

`unit acceptance correct`는 잘못 기록된 검증 종류와 시점을 정정한다. 원 요구·수용 기준·제품 기준·정책·실패·증거·재시도 이력을 보존한다. 제품 요구나 제품·운영이 섞인 기준을 재분류하거나 삭제하지 않는다. 원 요청 출처와 실제 기록 불일치를 검증할 수 없으면 이 명령을 사용할 수 없다.

## 요청과 증거

명령은 `unit acceptance correct <unit> --request <file> --user-input <ref>`다. 모든 명령에 원래의 roots와 `--adapters <module>`을 전달한다. 제출된 미수용 SelfGated 단위만 허용한다. 열린 단계·전달 계획·세션 종료·불확실한 효과는 없어야 한다. Blocked/Stopped 단위는 기존 진단·재개 계약과 재시도 상한을 먼저 따른다. 정정이 상태를 재개하거나 재시도 예산을 초기화하지 않는다.

관찰 정정 요청의 전체 키는 다음과 같다. 숫자와 digest 및 참조는 실제 관찰값으로 채운다.

```json
{
  "id": "observation-correction-1",
  "expectedRevision": 12,
  "acceptanceRef": "AC-5",
  "criterionDigest": "sha256:<원 기준 객체 canonical JSON 해시>",
  "sourceDigest": "sha256:<원 요청·정본·전체 기준 canonical JSON 해시>",
  "head": "<현재 Git head>",
  "contentFingerprint": "<현재 검증 내용 fingerprint>",
  "kind": "observation",
  "evidence": {"ref": "<독립 관찰 증거 참조>", "digest": "sha256:<증거 원본 바이트 해시>"},
  "provenance": {"ref": "<원 권한과 기록 불일치 증거 참조>", "digest": "sha256:<출처 증거 원본 바이트 해시>"},
  "reason": "원 권한에 따른 검증 방식 기록 정정"
}
```

전달 정정은 같은 공통 키를 사용하고 `kind`를 `delivery`로, `evidence` 키를 `level`과 `owner`로 교체한다. `level`은 `commit | push | pr | merge` 중 원 의무의 최소 수준이고 `owner`는 원 실행 소유자 `engine | external`이다. 예를 들어 외부 소유자의 commit·push·PR 의무는 `"kind":"delivery","level":"pr","owner":"external"`이다. 제공자는 소유자와 수준 모두를 원 권한에서 검증한다. `engine`만 엔진 정책·실제 실행 수준 이상의 의무를 요구한다. `external`은 원 `delivery:none`을 유지하며 엔진의 commit/push/PR 실행을 등록하거나 정책을 pr로 변경하지 않는다. 외부 실제 전달 증거는 수용 뒤 완료 경계에서 검증한다.

`unit progress`는 현재 revision, `correctionSourceDigest`, 기준별 `criterionDigests`, 저장된 head·내용 fingerprint와 정정 이력을 반환한다. Git 제공자는 실제 현재 대상과 일치하는지 별도로 확인한다. `sourceDigest`는 `{request: record.request, canon: record.canon ?? [], acceptance: record.acceptance ?? []}`의 digest다. 구조 digest는 [effectArgsDigest](../scripts/lib/approvals.mjs)의 재귀적 키 정렬 JSON SHA-256이며 참조 digest는 원본 바이트 SHA-256이다. 기준 digest에는 id·text·status를 포함한 기준 객체 전체가 들어간다.

새 정정마다 최신 revision을 사용한다. 같은 ID·payload·사용자 참조의 재호출은 기존 영수증을 반환한다. 같은 ID의 다른 요청은 거부한다. 새로운 영수증으로 관찰을 갱신할 수 있으나 분류·전달 소유자 변경·전달 수준 하향은 허용하지 않는다. 대상이 바뀌면 해당 대상의 새 관찰과 출처 검증이 필요하다. 원 영수증은 남는다.

## 목표 문구 변경과 기존 정정

승인된 공개 goal amend는 열린 결속 단위에 현재 목표 문구와 goalAmendmentHistory를 함께 기록한다. 이력은 원 목표 id·source, 목표 원장의 전체 amendment 행, amend 직후의 objective·criteria(current)를 담는다. 단위의 현재 목표 문구가 이력의 current와 정확히 같을 때만 이력을 사용한다. 목표 완료 사전검사는 목표 id·source가 원장과 같고, 이력이 원장 amendment 행의 앞부분이며, current가 그 행들 직후의 원장 목표 문구인지도 확인한다. 열린 단위는 amend마다 갱신되고 Closed 단위는 마지막 갱신 시점의 이력을 유지한다. 기존 정정은 이력의 이전 objective·criteria만 현재 요청에 대입했을 때 원 sourceDigest와 정확히 일치하는 출처로 검증한다. 요청의 다른 필드·정본·전체 기준은 현재 값 그대로 비교한다. 원 정정 요청·권한 참조·영수증·수용·독립 리뷰·실패는 보존한다. 새로운 정정과 unit progress의 correctionSourceDigest는 현재 출처를 사용한다.

이전 배포본의 목표 변경 뒤 Accepted 단위가 GOAL_INCOMPLETE 또는 ACCEPTANCE_CORRECTION_STALE로 막히면 공식 수정본에서 goal show로 현재 revision과 문구를 확인한다. goal amend는 active 목표만 받는다. 목표가 blocked이면 기존 goal resume 경로로 먼저 재개한다. 원 승인 범위 안에서 현재 objective·criteria를 그대로 담은 새 요청으로 다음 공개 명령을 실행한다. 원 roots와 신뢰 어댑터를 유지한다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" goal amend "$GOAL" --request goal-amend.json --user-input "$GOAL_AUTH" --adapters "$ADAPTER_MODULE"
```

명령은 승인 검증과 목표 revision 경합 검사를 거쳐 원 목표 이력을 같은 단위에 연결한다. 새 단위나 정정 영수증을 만들지 않는다. 이어 기존 소유자가 실패했던 원 finish/finalize 명령을 다시 실행한다. 이력 부재·다른 목표/source·그 밖의 요청/기준 변경은 복구하지 않는다.

출처 복원은 원 정정 권한과 관찰의 현재 재검증을 대신하지 않는다. 외부 전달 제공자는 해당 정정의 원 출처와 원 sourceDigest를 받고 실제 현재 전달 증거를 계속 검증한다. 목표 완료 사전검사도 같은 출처 해석을 사용하며, 원 수용 내용과 목표의 현재 기준을 계속 요구한다. [ADR 0040](adr/0040-goal-amendment-correction-provenance.md)을 따른다.

## 제공자 계약

호스트는 `createRuntimeAdapters`가 반환하는 기존 `provider`에 다음 정정 검증 메서드를 구현하며, 외부 전달에는 아래 `verifyExternalDelivery`도 구현한다. 사용자 입력 참조는 실제 원 저장소에서 읽고 검증한다. 미지원 참조 형식, 다른 사용자·세션의 참조, 출처 부재는 실패다. 코어는 참조 형식을 해석하거나 다른 제공자의 참조로 바꾸지 않는다.

`verifyUserInput(input)`의 정정 입력은 정확히 `{unit,userInputRef,argsDigest,sourceDigest,head,currentHead,contentFingerprint,targetDigest,effect,reason}`다. `effect`는 `unit.acceptance.correct`, `argsDigest`는 `{request,userInputRef}`의 구조 digest다. `targetDigest`는 현재 `git.inspectUnit` 전체 결과의 구조 digest다. 원 사용자 입력이 정확한 정정 요청을 승인했는지 원본에서 확인하고, 성공 시 입력의 모든 필드를 같은 값으로 반환하며 `verified:true`를 더한다. 일반 정책·효과 승인 계약도 그대로 유지한다.

`verifyAcceptanceCorrection(input)`의 입력은 위 공통 결속값에서 `effect,reason`을 제외한 `{unit,userInputRef,argsDigest,sourceDigest,head,currentHead,contentFingerprint,targetDigest}`와 `{request,source,target}`다. `source`는 앞서 정의한 원 요청·정본·전체 기준, `target`은 현재 Git 관찰 전체다. request/source/target은 복제된 데이터이며 승인 증거 자체가 아니다. 제공자는 다음을 독립적으로 확인한다.

- 사용자 입력과 원 정본을 실제 출처에서 읽고 digest·단위·권한·범위를 대조한다. provenance 참조의 원본 바이트 digest와 실제 기록 불일치를 확인한다.
- 해당 기준이 순수한 외부 운영 관찰 또는 명시적 전달 의무인지 확인한다. 제품 동작·혼합 기준, 요구 삭제·약화, 다른 기준의 증거는 거부한다. 전달 수준과 실행 소유자는 원 의무 전체와 원 소유권을 유지해야 한다. 엔진 소유 의무를 외부 소유로 바꿔 실행 요구를 회피하지 않는다.
- 관찰은 evidence 참조에서 실제 원본 바이트를 다시 읽고 digest를 확인한다. 관찰 대상의 신원·정책·유효성·현재 운영 문맥이 unit/source/target과 일치해야 한다. 요청 파일의 `verified:true`, 에이전트의 설명, digest 일치만으로는 성공이 아니다. 오래됐거나 폐기된 신원·정책·권한은 거부한다.
- 성공 시 공통 결속값 8개를 정확히 반환하고 `verified:true`를 더한다. 누락·다른 결속값·false·검증 불가·메서드 부재는 실패다. 입력을 그대로 돌려주는 구현은 검증자가 아니다.

두 메서드는 읽기 전용이며 정정 시뿐 아니라 수용과 전달에서도 재호출된다. 외부 조회 실패를 성공으로 캐시하지 않는다. 원래 head와 현재 head가 다른 경우는 기존 전달 엔진의 동일 트리 commit 결속/중단 복구 또는 아래의 외부 commit 검증 경로에서만 허용된다. 관찰은 원 검증 내용과 현재 운영 문맥 모두에 대해 유효해야 한다. 이 계약은 새 테스트 결과를 반환하지 않는다.

스키마·금지된 약화는 `ACCEPTANCE_CORRECTION_INVALID`, 원문·권한·대상 불일치는 `ACCEPTANCE_CORRECTION_STALE`, 제공자 검증 실패는 `ACCEPTANCE_CORRECTION_UNPROVEN`, ID 재사용 충돌은 `ACCEPTANCE_CORRECTION_CONFLICT`다. 제공자 부재는 `ADAPTER_MISSING`, 사용자 승인 실패는 기존 `EFFECT_APPROVAL_REQUIRED`다. 엔진 소유 의무보다 낮은 정책·finish는 `DELIVERY_OBLIGATION_REQUIRED`다. 외부 증거 검증 실패는 `EXTERNAL_DELIVERY_UNPROVEN`이며 `delivery:none` 자체는 오류가 아니다. 실패는 정본을 수정하지 않으며 실제 실행 결과가 불확실한 효과는 기존 원장 조정 절차를 따른다. 수용 대상에 기대는 직접 불가역 효과도 정정 출처와 관찰을 실행 전에 재검증한다.

`gates.describe('acceptance-coverage',{unit,record})`는 `record.acceptance`의 제품 기준만 검사한다. 전체 원문은 `record.acceptanceObligations`, 전체 정정 영수증은 `record.acceptanceCorrections`로 함께 받는다. 반환 명령·입력·설정·도구 버전은 실제 실행과 결속돼야 한다. 제어면이 정정 이력을 추가 fingerprint 입력으로 묶으며 게이트 결과는 기존 격리 실행·보고서 검증을 따른다. 다른 게이트에는 전체 기준을 유지한다. 스캐너의 누락 ID를 일괄 covers로 반환하지 않는다. 제공자가 별도 캐시나 이전 HEAD로 경로를 선택하면 그 선택을 원 대상에 맞게 검증해야 한다. 코어는 그 오류를 커버리지 완화로 보정하지 않는다.

## 외부 전달 제공자 계약

`provider.verifyExternalDelivery(input)`는 읽기 전용이다. 코어는 수용 시 외부 기준이 있으면 정책이 none이어도 `repo,branch,base,tree,indexTree,headTree`를 현재 Git 관찰에서 수용 대상에 결속한다. 제품 수용·리뷰는 실제 외부 PR 이전에 완료할 수 있다. 검증자는 finish, terminal projection, close/reconcile, finalize에서 재호출된다. 요청 파일의 증거나 예전 영수증만으로 재사용하지 않으며 현재 원격 상태와 원본 증거를 다시 읽는다. 호출은 단위 잠금 안에서 수행하므로 정본을 수정하거나 같은 잠금을 다시 획득하는 명령을 호출하지 않는다.

입력 전체는 `{unit,acceptanceRef,correctionDigest,sourceDigest,acceptedDigest,targetDigest,request,source,accepted,target}`다. 앞의 결속값 6개는 문자열이다. `correctionDigest`는 정정 영수증의 requestDigest, `acceptedDigest`는 현재 accepted 전체 객체의 구조 digest다. request는 검증된 owner=external 전달 정정 요청, source는 원 요청·정본·전체 기준, accepted는 수용 대상 전체, target은 현재 Git 관찰 전체다. 이 입력은 전달 실행 권한이 아니다.

성공 반환은 다음 형태다. 결속값 6개는 입력과 정확히 같아야 한다.

```js
{
  verified: true, unit, acceptanceRef, correctionDigest, sourceDigest, acceptedDigest, targetDigest,
  evidence: {ref: "<현재 원격 관찰의 검증 가능한 원본 참조>", digest: "sha256:<원본 바이트 해시>"},
  delivery: {level: "pr", repo, branch, base, head, contentFingerprint,
    pr: "<실제 PR의 안정적인 문자열 참조>", status: "open"}
}
```

제공자는 실제 commit·push·PR의 연결과 원격 head, 저장소·브랜치·base·수용 내용의 일치를 독립 확인한다. 임의 사용자 파일이나 입력 tuple의 echo는 증거가 아니다. 원본을 읽고 바이트 digest·현재 유효성·접근 신원·대상 결속을 확인한다. 누락, 폐기, stale, 다른 unit/correction/수용 대상, 닫힌 미병합 PR, 확인 실패는 verified:false 또는 오류다. `delivery.level`은 원 최소 수준 이상이며 repo/branch/base/head/contentFingerprint는 target과 같아야 한다. PR 이상은 비어 있지 않은 pr 문자열과 status=open 또는 merged가 필수다. merge 의무는 status=merged와 실제 mergeHead도 필요하다. push만으로 PR 의무를 충족하지 않는다.

코어는 내용 fingerprint·repo·branch·base·tree가 수용 값과 같고 실제 headTree와 indexTree가 수용 tree인지 확인한다. 수용 뒤 외부 stage로 바뀐 인덱스는 이 조건으로 검증하며 이전 인덱스와 같다고 가정하지 않는다. head가 바뀌면 headParent=직전 accepted.head인 직접 자식 commit만 결속한다. 같은 head에서 불변 headTree가 달라진 관찰도 거부한다. 기존 bindDeliveryCommit을 재사용하고 validatedHead·리뷰 SHA를 보존한다. 그 밖의 변경과 이미 완료한 엔진 전달의 head 변경은 자동 승인하지 않고 재수용한다. none 전달 뒤 외부 SHA를 다시 결속하면 deliveryResult.head도 같은 SHA로 유지한다. 외부 제공자에게 저장소 쓰기·실행 메서드는 필요 없다.

완료 경계는 읽기 전용 검증 후 대상이 그대로인지 다시 관찰하고 `externalDeliveryEvidence`에 `{unit,acceptanceRef,correctionDigest,sourceDigest,acceptedDigest,targetDigest,evidence,delivery,beforeAccepted,accepted,digest,verifiedAt}` 영수증을 추가한다. 동일 증거의 재검증은 중복 영수증을 만들지 않는다. 실패는 새 영수증·결과·완료 투영·세션 종료를 허용하지 않으며 이전 이력을 보존한다. 원 정책과 deliveryResult.level=none/effectRefs=[]를 유지하고 외부 전달을 엔진 실행 원장이나 테스트 covers로 기록하지 않는다.

## 복구 순서

수정이 포함된 공식 배포본을 다운로드하고 버전·소스 출처·배포 무결성을 확인한다. 설치 사본 직접 패치나 단위 JSON 수동 편집은 사용하지 않는다. 호스트 제공자가 위 계약과 실제 사용자 입력 참조를 지원하고, 올바른 대상에서 제품 증거를 수집하는 것이 선행 조건이다. 공식 배포·호스트 연결 전에는 실단위에 실행하지 않는다.

다음 함수는 원 제품 cwd에서 실행한다. 변수는 검증한 공식 패키지 경로·원 단위·원 roots·신뢰 모듈·실제 승인 참조다. 요청 파일은 위 형식을 사용한다.

```sh
cd "$PRODUCT_ROOT"
repair_cli() { node "$PLUGIN_ROOT/scripts/unit.mjs" "$@" --state-root "$STATE_ROOT" --project-root "$PRODUCT_ROOT" --adapters "$ADAPTER_MODULE"; }
repair_cli unit progress "$UNIT"
repair_cli unit acceptance correct "$UNIT" --request observation-correction.json --user-input "$CORRECTION_AUTH"
repair_cli unit progress "$UNIT"
# 최신 revision으로 작성한 전달 정정 요청을 사용한다.
repair_cli unit acceptance correct "$UNIT" --request delivery-correction.json --user-input "$CORRECTION_AUTH"
repair_cli unit accept "$UNIT"
```

exit 20이면 기존 [독립 리뷰 절차](getting-started.md#구현-이후)를 수행한다. 실제 독립 리뷰가 원 단위를 targetUnit으로 참조하고 StageOutput을 제출해야 한다. 이미 생성된 리뷰의 ship을 복사하지 않는다. 새 리뷰 단위는 독립 리뷰 책임용이며 구현 단위를 대체하지 않는다. 리뷰 후 동일 원 명령 `repair_cli unit accept "$UNIT"`를 다시 실행한다. exit 0/Accepted 뒤 원 실행 소유자가 기존 승인 절차로 외부 전달을 수행한다. 외부 PR을 실제로 읽고 검증하는 제공자를 연결한 뒤 원래의 finish 요청과 `requestedDelivery:none`으로 `repair_cli unit finish "$UNIT" --request finish.json`을 실행한다. PR이 아직 없으면 finish를 완료하지 않는다. finalize 대기 중 증거가 폐기되면 동일 원 단위의 `repair_cli unit finalize "$UNIT"`도 완료하지 않는다. 엔진 소유 전달만 해당 엔진 정책과 전달 수준을 따른다. 전달 실행·검증 실패는 기존 원장·진단·재시도 정책으로 처리한다.

목표에 연결된 세션 리뷰는 아래 명령을 사용한다. `review-request.json`은 `kind:review`, `targetUnit:$UNIT`, 원 `goalId`, 검증 가능한 request를 포함하고 `review-session.json`은 기존 세션 시작 계약과 원 목표 정책을 따른다. stage 명령은 기동된 독립 리뷰어가 실행하며 `review-output.json`은 그 실제 StageInput에 결속된 출력이다. 마지막 두 명령은 원 구현 단위 소유자가 실행한다. 사람 리뷰 정책은 기존 `--by user` 경로를 따른다.

```sh
repair_cli unit start "$REVIEW_UNIT" --request review-request.json
repair_cli unit session-start "$REVIEW_UNIT" --request review-session.json
repair_cli unit stage open "$REVIEW_UNIT" review
repair_cli unit stage submit "$REVIEW_UNIT" review --output review-output.json
repair_cli unit accept "$UNIT"
# 외부 전달은 원 소유자가 수행하고, finish.json의 requestedDelivery는 none으로 유지한다.
repair_cli unit finish "$UNIT" --request finish.json
repair_cli unit finalize "$UNIT" # finish가 finalizePending인 경우 같은 단위/roots로 실행
```
