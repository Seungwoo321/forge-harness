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

세션 연결에는 패키지의 `scripts/lib/session-runtime.mjs`가 `createSessionRunner({runtime,command,parent,launch,runtimeRpc,taskTransport,taskPrompt})`를 제공한다. `runtime`은 `cmux` 또는 `orca`; `parent`는 실제 `sessionId`, `incarnationId`, `cwd`; `launch`는 승인된 후속 실행 argv를 만든다. Orca는 `terminal.inspectProcess`를 제공하는 실제 transport를 `runtimeRpc`로 연결한다. runtime 설정 모듈이 SDK 발견·버전·수명을 소유한다. 호스트 화면이나 입력 전송만으로 실제 착수를 선언하지 않는다.

Codex argv의 마지막 인자는 정확한 초기 prompt다. 기본 Codex transport는 worker PID의 열린 native writer lock으로 thread를 결속한다. 같은 프로세스에 여러 lock이 있으면 native metadata의 source가 cli 또는 exec이고 cwd가 일치하는 유일한 주 thread를 선택하며 subAgent는 제외한다. 별도 `codex app-server --stdio`의 `thread/read`, `thread/turns/list`, `thread/queue/list`로 실제 기록을 읽는다. 지원 프로토콜은 설치된 CLI가 제공해야 하며 누락 시 차단된다. 최초 prompt는 TUI가 자동 제출하므로 startup 중 키를 보내지 않는다. cmux의 기존 owner 결과 전달은 짧은 불변 packet 참조를 인식된 빈 composer에 붙여 넣고, 두 번의 동일한 settled 관찰과 worker/thread 재확인 뒤 별도 Return으로 제출·steer한다. 다른 초안·modal·미지원 화면에는 입력하지 않는다. 의미 있는 공백은 보존하고 복원할 수 없는 줄바꿈 composer는 거부한다. 짧은 결과 참조를 사용하며, 화면 폭이 부족하면 미완료로 남는다. 이미 정확한 composer가 있으면 재붙여넣지 않는다. native exact userMessage와 그 뒤 실제 packet 읽기·실행 항목으로만 수신을 확인한다. 읽기 증거는 native read action 또는 일치하는 파일 경로·digest의 checksum 출력과 실제 packet 본문이다. cmux 이외의 기본 경로는 native queue를 사용하며 대기만으로 완료되지 않는다. 기존 초기 prompt도 정확한 본문과 실제 packet 읽기를 검증한다. 이전 버전의 전체 본문 전달 prompt는 먼저 읽기 전용으로 관찰하여 이미 접수된 요청을 재제출하지 않는다. 앱 서버 기록을 읽는 프로세스는 기존 thread를 resume하거나 탈취하지 않는다.

다른 worker는 명시적 `taskTransport`를 등록한다. `observe({observed,input,prompt,packets})`는 `startup|modal|ready|prefilled|queued|accepted|started`와 네이티브 근거를 반환한다. `started`에는 promptDigest·threadId·requestId·turnId·activityId·packets가 필요하다. `submit({...request,fence})`는 같은 native readiness fence에서 정확한 입력만 조건부 제출한다. interactive pending 입력의 Enter와 busy 입력의 steering/queue는 이 transport가 처리한다. 화면은 composer 준비 관찰에만 쓰고 승인·수신 증거로 쓰지 않는다. cmux는 원자적 composer API가 없으므로 native identity와 정확한 화면을 입력 전 재검사하며 receipt를 별도로 검증한다. `identity(observed)`는 실제 worker의 threadId를 반환한다. `taskPrompt(args,argv)`는 초기 prompt 형식이 다른 worker에만 필요하다.

자동 종료에는 `parent.workerExecutable`과 `parent.closable: true`가 필요하다. incarnation은 해당 worker의 실제 관찰값이며 wrapper 셸의 PID로 대체하지 않는다. `unit finish`는 결과/인계를 고정한 뒤 exit 3을 반환하고 분리된 finalizer를 기동한다. 그 로그는 `<stateRoot>/units/<unit>/finalization.log`다. finalizer만 결과 수신·착수, close intent, 정확한 worker 신원, 종료 뒤 부재를 확인하고 Closed를 기록한다. `returnTo: {sessionId,incarnationId,cwd,executable}`를 주면 기존 parent로 결과를 돌려보낸다. 수신이 지연되거나 종료가 불확실하면 같은 `unit finalize <unit> --adapters <module>` 또는 원래 finish를 재호출한다. 초기 session.start의 unit·role·attempt·args·key는 변경하지 않는다. 기존 원장·결과 파일을 새 필드에 맞춰 직접 수정하지 않는다.

반환 의무는 tracker 투영 전에 저장되며 public close/reconcile도 이를 우회하지 못한다. 구버전 process-only result는 같은 seq/key의 실제 native 재관찰로 보강하고 원 행을 남긴다. cmux의 마지막 surface 종료에는 종료된 빈 placeholder surface를 먼저 만든다. workspace 전체 종료는 사용하지 않으므로 동시에 추가된 다른 surface는 유지된다. 종료 뒤 해당 workspace에는 빈 surface가 남을 수 있다.

전달 문맥은 `resourceOwned`, `productOwned`, `inScope`, `operational`, `irreversible`, `containsSecret`, `forbiddenCommand`의 boolean을 제공한다. 사용자 지시는 신뢰된 제공자가 검증하며 요청 파일의 자기 신고로 승격하지 않는다. 등록 실패는 구조화된 RESULT로 나오고 필수 제공자가 없는 연산은 차단된다.

전체 계약: [명세 §7·§8](spec.md#7-스킬-구성과-계약). 런타임 경계: [runtime-adapters.mjs](../scripts/lib/runtime-adapters.mjs). 외부 호출 진입점: [adapters.mjs](../scripts/lib/adapters.mjs).

미수신 재시도는 native history/queue에 요청이 없고 정확한 입력이 composer에 남아 있을 때만 정책 상한 안에서 같은 intent로 Enter를 재개한다. 빈 composer나 단순 조회 실패로는 미제출을 추정하지 않는다.
