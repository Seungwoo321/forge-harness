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

기본 패키지는 환경별 게이트·원격·작업관리·세션을 임의로 선택하지 않는다. [런타임 연결](runtime-adapters.md)을 먼저 구성한다. 리뷰가 필요하면 exit 20/InReview가 반환된다. 새 독립 세션에서 `kind: review`, `targetUnit`을 지정한 요청으로 리뷰 단위를 시작하고 review 계약을 제출한다. 사람 리뷰 정책이면 `stage submit ... review --by user`를 사용한다.

수용 후 `unit finish <unit> --request finish.json --adapters <module>`가 전달과 후속 처리를 수행한다. finish 요청·세션 identity 계약은 [명세 §7](spec.md#7-스킬-구성과-계약)에 있다. 결과만 쓰고 종료·전달을 가장하지 않는다. `unit fail`, `unit retry`, `unit resume`는 저장된 실패와 시도 상한을 사용하며 상태 파일을 수동 수정하지 않는다.

각 CLI는 사람이 읽는 요약 뒤 한 줄 `RESULT { ... }`를 출력한다. 키는 RESULT 최상위에 있다. exit 0은 해당 명령의 성공, 1은 검사 실패, 2는 입력/계약 오류, 3은 정책/권한/결정 대기, 4는 필수 어댑터 부재, 20은 리뷰 필요다.
