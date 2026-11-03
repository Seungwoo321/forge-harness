# 첫 작업 단위

이 안내는 설치된 패키지와 작업할 Git 프로젝트를 분리한다. `PLUGIN_ROOT`는 플러그인 설치 디렉터리이고 모든 명령의 cwd는 **사용자의 프로젝트**다. 스킬은 자기 설치 위치 두 단계 위에서 패키지 루트를 찾는다. 호스트 캐시 경로를 고정해 두지 않는다.

## 정책 확인과 저장

```sh
node "$PLUGIN_ROOT/scripts/policy.mjs" policy detect --json
node "$PLUGIN_ROOT/scripts/policy.mjs" policy resolve --json
```

정책이 없으면 `POLICY_UNSET`(exit 3)을 반환한다. 정책 설정 스킬은 목표 유형·저장 수준·전달 상한·리뷰/재시도를 사용자에게 확인한다. 사용자 답을 초안 JSON으로 만든 뒤 CLI에 넘긴다. 예제의 `task`/`none`은 데모 값이므로 사용자 확인 없이 실제 정책으로 적용하지 않는다.

```sh
node "$PLUGIN_ROOT/scripts/policy.mjs" policy set --level project --draft policy-draft.json
```

초안의 최소 형태는 [examples/policy.json](../examples/policy.json)이다. `goal.class`는 `task`, `product-prelaunch`, `product-live`; `delivery`는 `none`, `commit`, `push`, `pr`, `merge`다. goal 유형의 권한과 delivery 상한은 별개다. `review.mode`, `review.by`, `retry.maxPerSignature`, `retry.maxResolver`를 명시적으로 조정할 수 있다. 전체 필드는 [명세 §5](spec.md#5-process-profile-과-work-policy)에 있다.

project 정책은 `<git-common-dir>/work-state/policy.json`에 저장된다. workspace 저장은 `--level workspace --workspace-root <실제-조상-경로>`, global 저장은 `--level global --global-root <provider-config>`를 쓴다. 단위 CLI에도 필요한 검색 루트를 전달한다. 값의 우선순위는 사용자 → 단위 → project → workspace → global이며 필드별 출처를 기록한다.

Git 밖에서는 정책·단위 명령 모두 `--state-root <절대-상태-경로> --project-root <절대-프로젝트-경로>`가 필요하다. scope 단계의 체크포인트는 Git이 필요하므로 이 첫 실행은 초기 commit이 있는 Git 프로젝트에서 한다.

## 시작과 첫 단계

요청 JSON은 [examples/request.json](../examples/request.json) 형태다. `request.userInputRef`는 실제 사용자 요청의 참조이며, `canon`은 `{path,digest}` 배열이다. 예제 참조는 데모에서만 쓴다. `kind`는 `impl`, `design`, `review`, `chore`, `ops`이며 프로필이 단계와 필수 게이트를 정한다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit start greeting --request request.json
node "$PLUGIN_ROOT/scripts/unit.mjs" unit stage open greeting scope
```

`RESULT` JSON의 `input` 경로를 scope 스킬에 전달한다. 스킬은 StageInput과 패키지의 `skills/scope/contract.json`을 읽고 별도 StageOutput JSON을 반환한다. input 봉투나 Unit Record를 편집하지 않는다. output은 다음 구조이며 digest·attempt는 **이번 input의 값**으로 바꾼다.

```json
{
  "inputDigest": "<input.inputDigest>",
  "attempt": 1,
  "submissionId": "greeting-scope-1",
  "status": "done",
  "summary": "Scope the greeting change",
  "acceptance": [{"id": "AC-1", "text": "greeting.txt contains Hello world."}],
  "scopePaths": ["greeting.txt"],
  "assumptions": [],
  "openDecisions": []
}
```

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit stage submit greeting scope --output scope-output.json
node "$PLUGIN_ROOT/scripts/unit.mjs" unit stage open greeting implement
node "$PLUGIN_ROOT/scripts/unit.mjs" unit progress greeting
```

제출 후 Implementing으로 전이하고 implement StageInput에 확정 기준과 허용 경로가 담긴다. [실행 가능한 데모](../examples/first-run.mjs)는 이 경계를 임시 Git 프로젝트에서 검사하고 삭제한다. [기록된 요약](../examples/first-run.txt)은 그 CLI 출력이며 모델 실행·완료된 제품 수용을 뜻하지 않는다.

## 구현 이후

implement 스킬이 계약에 맞는 출력을 반환하면 같은 `stage submit` 경로로 제출한다. SelfGated에서 `unit accept <unit> --adapters <module>`가 게이트를 실행하고 증거·커버리지·정책을 판정한다. gates는 LLM 출력 단계가 아니다.

기본 패키지는 환경별 게이트·원격·작업관리·세션을 임의로 선택하지 않는다. [런타임 연결](runtime-adapters.md)을 먼저 구성한다. 리뷰가 필요하면 관찰한 head·내용 fingerprint를 저장하고 exit 20/InReview가 반환된다. 새 독립 세션에서 `kind: review`, `targetUnit`을 지정한 요청으로 리뷰 단위를 시작하고 review 계약을 제출한다. 사람 리뷰 정책이면 `stage submit ... review --by user`를 사용한다.

수용 후 `unit finish <unit> --request finish.json --adapters <module>`가 전달과 후속 처리를 수행한다. finish 요청·세션 identity 계약은 [명세 §7](spec.md#7-스킬-구성과-계약)에 있다. 결과만 쓰고 종료·전달을 가장하지 않는다. `unit fail`, `unit retry`, `unit resume`는 저장된 실패와 시도 상한을 사용하며 상태 파일을 수동 수정하지 않는다.

열린 구현 단계에서 승인된 상위 변경을 통합해 HEAD가 바뀌어 `CHECKPOINT_STALE`이 발생하면 `unit stage restart <unit> implement --request <file>`을 사용한다. 요청 JSON에는 기존 시도의 `attempt`, `inputDigest`, `checkpointHead`와 현재 `newHead`를 정확히 담는다. 제어면은 Git HEAD와 참조 잠금 아래에서 현재 HEAD가 기존 HEAD의 후손인지 확인하고 기존 시도를 보존한 채 종료한다. 파일 기반 Git 참조 저장소만 지원하며 잠금을 얻지 못하면 재개하지 않는다. 이어 `unit stage open <unit> implement`로 확인한 HEAD에 묶인 같은 단위의 다음 시도를 연다. 작업 파일과 이전 증거는 그대로 두며 새 수용과 리뷰는 현재 내용에 대해 수행한다.

같은 범위와 책임으로 계속할 때 finish 요청에 `sameSession: {"approved": true, "nextUnit": "<unit>"}`을 넣는다. 결과에는 남은 일과 다음 행동을 쓰며 전체 목표 완료를 설정하지 않는다. 단위만 닫히고 세션은 계속된다.

세션 인계의 finish는 정확한 요청 착수 후 분리된 finalizer를 기동하며 그동안 exit 3/Delivered다. 기존 세션으로 돌아갈 때는 새 successor 대신 `returnTo`를 지정한다. finalizer는 결과 수신·착수와 실제 owner 종료를 확인한 뒤 Closed를 기록한다. 대기 중 재개는 같은 roots와 `--adapters`로 `unit finalize <unit>`를 실행한다. 네이티브 제출·종료 설정은 [런타임 연결](runtime-adapters.md)을 따른다.

각 CLI는 사람이 읽는 요약 뒤 한 줄 `RESULT { ... }`를 출력한다. 키는 RESULT 최상위에 있다. exit 0은 해당 명령의 성공, 1은 검사 실패, 2는 입력/계약 오류, 3은 정책/권한/결정 대기, 4는 필수 어댑터 부재, 20은 리뷰 필요다.

## 진행 중인 단위의 전달·리뷰 정책 변경

사용자의 명시적인 정책 변경은 기존 단위를 새로 만들지 않고 공개 명령으로 적용한다. 사용자 입력 출처를 검증하는 provider가 필요하다. 단계 제출이 끝나고 미확정 효과가 없는 SelfGated 또는 Accepted 상태에서 아래 요청을 사용한다. `unit progress <unit>`의 `revision`과 `effectiveDelivery`로 현재 값을 확인한다. `expectedRevision`은 현재 단위 revision이며, 요청 ID와 사용자 입력 참조는 같은 재시도에서 유지한다.

```json
{"id":"delivery-change-1","expectedRevision":12,"delivery":"merge","reason":"사용자가 merge를 지정"}
```

필수 독립 리뷰가 필요한데 기존 정책이 `none`이면 사용자 승인 후 같은 명령에 `delivery` 대신 전체 `review` 값을 전달한다. 예를 들면 `"review":{"mode":"required","by":"session","triggers":[]}`이다. 이 변경은 전달 수준을 바꾸지 않는다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit policy change greeting --request policy-change.json --user-input '<검증 가능한 사용자 입력 참조>' --adapters runtime.mjs
node "$PLUGIN_ROOT/scripts/unit.mjs" unit accept greeting --adapters runtime.mjs
```

변경 전 정책·수용·리뷰는 이력에 보존되며 기존 증거와 효과는 삭제하지 않는다. 변경 후 같은 단위의 수용 대상을 다시 검증한다. 변경 후 finish는 해당 전달 수준을 기본으로 사용하며 다른 수준을 요청하려면 다시 명시적으로 정책을 변경한다.

## 기존 지적의 명시적 해소

prelaunch의 공개 scope도 `scopePaths`를 권한 경계로 사용한다. 별도로 기록된 `productPaths`가 있을 때만 그 경계를 사용하며, 명시적인 빈 배열은 모든 경로를 거부한다. 경로를 추가하지 않고 기존 자동 생성 범위 지적을 다시 검사한다:

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit scope recheck greeting --adapters runtime.mjs
```

현재 승인 경로에 모두 포함되는 자동 생성 지적만 해소한다. 원문·인덱스·digest·검사 범위는 `scopeRechecks`에 보존되고, 실제 범위 이탈이나 리뷰어 지적은 남는다. 재호출은 변경 없이 빈 resolved 배열을 반환한다.

리뷰어의 과거 지적은 별도 명시적 요청으로 해소한다. 수정 후 완료된 독립 ship 리뷰와 지적별 수정 증거가 필요하며 ship만으로는 해소되지 않는다. `finding-fixes.json`은 다음 형태다:

```json
{
  "id": "verified-fixes-1",
  "expectedRevision": 18,
  "head": "<current head>",
  "contentFingerprint": "<current content fingerprint>",
  "findings": [{"index": 0, "digest": "sha256:<original finding digest>"}],
  "review": {"unit": "greeting-review", "attempt": 1, "outputPath": "review-output.json", "outputDigest": "sha256:<output object digest>"},
  "reviewer": "<actual independent reviewer identity>",
  "evidence": {"path": "independent-verification.json", "digest": "sha256:<report byte digest>"},
  "reason": "Independent verification demonstrates the specified fixes"
}
```

revision은 범위 재검사 후 원 단위의 값이다. finding과 output의 digest는 패키지 `scripts/lib/approvals.mjs`의 `effectArgsDigest`로 전체 객체를 정규화해 계산한다. 보고서는 원 바이트의 SHA256이다. 실제 값과 원본 파일을 사용하며 상태·신원·증거를 만들어 채우지 않는다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit finding resolve greeting --request finding-fixes.json --user-input actual-authorization-reference --adapters runtime.mjs
node "$PLUGIN_ROOT/scripts/unit.mjs" unit accept greeting --adapters runtime.mjs
```

trusted `provider.verifyUserInput`은 `{unit,userInputRef,effect:'finding.resolve',argsDigest,head,contentFingerprint,reviewer,independent:true,reason}` 전체를 검증하고 같은 필드와 `verified:true`를 반환한다. `argsDigest`는 `{request,userInputRef}`의 `effectArgsDigest`다. provider는 요청 파일의 선언을 승인으로 반사하지 않고 실제 사용자 권한, 리뷰어와 모든 구현자의 독립성, 리뷰어가 작성한 원 지적과 지적별 수정 증거를 확인한다. 이 입력을 검증할 신뢰 연결이 없으면 exit 3이며 해소하지 않는다.

완료된 리뷰와 현재 대상·수용 기준·게이트 증거가 일치해야 한다. 후속 구현이나 리뷰가 있으면 이전 리뷰로 해소할 수 없다. 구버전 accept가 ship 필드를 지운 경우에도 이 검증을 통과한 원본 ship만 복원하며 영수증에 이전 필드를 보존한다. 같은 요청의 재호출은 기존 영수증을 반환하고, 다른 payload·오래된 revision·소스/증거 변경은 거부한다. 기존 단계·지적·실패·게이트 증거는 삭제하지 않으며 마지막 accept가 수용을 별도로 판정한다.

구버전에서 `REVIEW_TARGET_INVALID`로 멈춘 InReview 단위는 새 패키지와 같은 런타임 어댑터로 기존 리뷰 단위의 `unit stage open <review-unit> review`를 다시 실행한다. 제어면은 저장된 reviewDecision을 현재 내용과 대조하고 실제 diff·구현 인계를 생성한다. 단위나 증거 파일을 직접 수정하지 않는다. 내용이 바뀌면 열기·제출을 거부하므로 대상 단위에서 `unit accept <unit>`로 다시 검증하고 현재 대상을 리뷰한다. 같은 입력의 게이트 증거는 재사용한다.
