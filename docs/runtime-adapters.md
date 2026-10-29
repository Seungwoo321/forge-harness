# 런타임 연결

패키지의 Node CLI가 결정적 처리를 소유한다. Git 체크포인트와 명령 실행은 내장되어 있고, 환경별 Git 수용 관찰·게이트·전달·작업관리·세션은 명시적인 모듈로 등록한다. 호스트에서 선택한 신뢰할 수 있는 모듈만 실행한다.

```sh
node "$PLUGIN_ROOT/scripts/unit.mjs" unit accept greeting --adapters ./runtime.mjs
```

모듈은 아래 named export를 제공한다. `cwd`는 사용자 프로젝트, `adapters`는 불변 내장 명령·체크포인트·clock·ID 서비스다. 모듈 경로는 cwd 기준이고 매 명령에 전달한다.

```js
export async function createRuntimeAdapters({ cwd, adapters }) {
  return {
    git: projectGit,
    gates: projectGates,
    // tracker, sessionRunner, repository, provider, effect, effectContext
  };
}
```

이 코드는 등록 형태다. `projectGit`·`projectGates`는 사용 환경에서 구현한 제공자이며 예제만 복사해서 실행할 수는 없다. 외부 명령은 `adapters.command(binary, argv, {cwd})`로 호출한다. 반환값은 `{exitCode,stdout,stderr}`이고 셸 문자열을 조합하지 않는다.

| 제공자 | 필수 메서드와 책임 |
|---|---|
| `git` | `inspectUnit({unit})`: 현재 `head`, `contentFingerprint`, `changedPaths` 등 수용 관찰. 전달 시 `deliveryContext`, `execute`, `verify` 추가 |
| `gates` | `describe(id,{unit,record})`, `run(gate,{unit,record})`: 게이트 입력·설정·도구 버전과 실제 결과 반환 |
| `tracker` | `read`, `project`: 외부 작업관리 읽기·멱등 투영. tracker가 없는 단위는 등록 불필요 |
| `sessionRunner` | 계약 `harness.session-adapter/1`, 기능 목록, `observe`, `execute`, `verify`: 신원·cwd 관찰, 기동/종료, 실제 효과 검증 |
| `repository` | PR 생성·머지의 `deliveryContext`, `execute`, `verify` |
| `provider` | `verifyUserInput`: 사용자 승인 입력의 실제 출처 확인 |
| `effect` + `effectContext` | 일반 외부 효과의 `execute`, `verify` 및 신뢰 경계 boolean 문맥. 두 제공자는 함께 등록 |

`contentFingerprint`는 검증 경로·바이트·파일 모드와 포함/제외 규칙의 정렬된 해시다. `head`만으로 변경된 작업트리의 검증을 대체하지 않는다. delivery를 사용하는 관찰에는 `repo`, `branch`, `tree`, `indexTree`, `headTree`, `base`를 추가한다. 요청이 관찰 결과나 승인 대상을 덮어쓸 수 없다.

게이트의 `describe`는 id/version/command/config, 입력 파일 내용, 도구 버전을 담는다. `run`은 판정과 원 결과 참조를 돌려준다. 정확한 객체 형태와 실제 실행 예는 [공개 CLI 통합 테스트](../scripts/public-control-plane.test.mjs), [실행 파일 통합 테스트](../scripts/unit-executable.test.mjs), [증거 모듈](../scripts/lib/evidence.mjs)이 제공한다. 테스트의 stub 런타임은 실사용 제공자를 대신하지 않는다.

세션 연결에는 패키지의 `scripts/lib/session-runtime.mjs`가 `createSessionRunner({runtime,command,parent,launch,runtimeRpc})`를 제공한다. `runtime`은 `cmux` 또는 `orca`; `parent`는 실제 `sessionId`, `incarnationId`, `cwd`; `launch`는 승인된 후속 실행 argv를 만든다. Orca는 `terminal.inspectProcess`를 제공하는 실제 transport를 `runtimeRpc`로 연결한다. runtime 설정 모듈이 SDK 발견·버전·수명을 소유한다. 호스트 화면이나 입력 전송만으로 실제 착수를 선언하지 않는다.

전달 문맥은 `resourceOwned`, `productOwned`, `inScope`, `operational`, `irreversible`, `containsSecret`, `forbiddenCommand`의 boolean을 제공한다. 사용자 지시는 신뢰된 제공자가 검증하며 요청 파일의 자기 신고로 승격하지 않는다. 등록 실패는 구조화된 RESULT로 나오고 필수 제공자가 없는 연산은 차단된다.

전체 계약: [명세 §7·§8](spec.md#7-스킬-구성과-계약). 런타임 경계: [runtime-adapters.mjs](../scripts/lib/runtime-adapters.mjs). 외부 호출 진입점: [adapters.mjs](../scripts/lib/adapters.mjs).
