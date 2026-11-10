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

목표에 연결된 세션은 패키지의 `scripts/session-adapter.mjs`가 `sessionRunner`를 구성한다. 설정 모듈은 이 모듈의 `createRuntimeAdapters` 결과와 프로젝트의 `git`, `gates` 제공자를 합쳐 반환한다. 명령에는 `--state-root`를 명시한다. 시작·종료 요청의 `parentRuntime`은 runtime, sessionId, incarnationId, 절대 cwd, workerExecutable을 포함하며, finalizer는 저장된 owner를 다시 관찰한다. 설정에 전달되는 인자는 `{cwd, adapters, options, argv}`다.

| 제공자 | 필수 메서드와 책임 |
|---|---|
| `git` | `inspectUnit({unit})`: 현재 `head`, `contentFingerprint`, `changedPaths` 등 수용 관찰. 전달 시 `deliveryContext`, `execute`, `verify` 추가 |
| `gates` | `describe(id,{unit,record})`: 실행 명령과 전체 입력·설정·도구 버전·출력 형식을 기술 |
| `tracker` | `read`, `project`: 외부 작업관리 읽기·멱등 투영. tracker가 없는 단위는 등록 불필요 |
| `sessionRunner` | 계약 `harness.session-adapter/1`, 기능 목록, `observe`, `execute`, `verify`: 신원·cwd 관찰, 기동/종료, 실제 효과 검증 |
| `repository` | PR 생성·머지의 `deliveryContext`, `execute`, `verify` |
| `provider` | `verifyUserInput`: 사용자 승인 입력의 실제 출처 확인. 승인된 기준 제외에는 `verifyAcceptanceChange`, 검증 방식 정정에는 `verifyAcceptanceCorrection`, 외부 소유 전달에는 `verifyExternalDelivery`도 필수. 원 권한·기록 불일치·관찰/현재 외부 전달 증거를 읽기 전용 검증 |
| `effect` + `effectContext` | 일반 외부 효과의 `execute`, `verify` 및 신뢰 경계 boolean 문맥. 두 제공자는 함께 등록 |

`contentFingerprint`는 검증 경로·바이트·파일 모드와 포함/제외 규칙의 정렬된 해시다. `head`만으로 변경된 작업트리의 검증을 대체하지 않는다. delivery를 사용하는 관찰에는 `repo`, `branch`, `tree`, `indexTree`, `headTree`, `base`를 추가한다. 요청이 관찰 결과나 승인 대상을 덮어쓸 수 없다.

상류 통합 뒤 scope recheck의 귀속 복구는 제공자가 승인 설정에서 읽은 `baseRef`와 `base`를 사용한다. `baseRef`는 heads/remotes 참조로 해석되고 현재 브랜치와 달라야 한다. `base`는 현재 HEAD와 그 참조의 유일한 merge-base이며 최초 체크포인트 HEAD의 후손이다. `repo`, `branch`, `head`, `tree`, `contentFingerprint: git-tree:<tree>`, `changedPaths`는 같은 제출 대상의 실제 Git 관찰이다. 체크포인트 inspection의 `contentTree`는 tracked와 무시되지 않은 untracked에서 명시적 정책 제외만 제거한 full-content view다. 기존 `tree`는 Git ignore가 제거한 tracked 파일까지 제외한 checkpoint projection이며 `excluded`에 정확한 경로를 반환한다. 제어면은 full-content 증거를 `contentTree`와 검증하고 같은 view에서 단위 diff를 다시 계산해 제공자 관찰과 대조한다. 두 tree와 제외 목록은 영수증에 별도로 기록하며 파일 이름에 따른 예외는 없다. 사용자 요청으로 base·경로를 덮어쓰거나 파일 이름만으로 상류 제외를 선언하지 않는다. 메타데이터가 없으면 기존 경로 검사만 수행하며, 불완전하거나 stale한 base 관찰은 복구를 허용하지 않는다.

게이트의 `describe`는 id, 실행할 `command` 배열, `config`, 모든 입력 파일의 상대 경로·내용·실행 모드, 도구 버전과 보고서 형식을 담는다. 제어면은 입력을 원본과 대조해 격리된 사본으로 만들고 그 사본에서 명령을 직접 실행한다. 원본 작업 트리는 실행 프로세스에 노출하지 않는다. 실행 전후의 사본과 현재 대상·게이트 입력을 확인하고 실제 stdout을 내용 주소형 보고서로 보존한다. 입력 파일에는 실행에 필요한 프로젝트 소스·설정·의존성을 포함한다. 내부 상대 심볼릭 링크는 `mode: "120000"`과 링크 대상 문자열로 기술하며 외부 탈출은 거부한다. 격리 실행 영수증이 없는 예전 통과 증거는 보존하되 새 수용에서 재사용하지 않는다.

실행 중 생성할 디렉터리는 `outputDirectories`에 상대 경로로 선언한다. 제어면은 입력과 겹치지 않는 디렉터리만 쓰기 가능하게 만들고 이 목록을 fingerprint에 포함한다. pnpm이 `node_modules`를 생성해야 한다면 해당 경로를 선언하고 `package.json`과 `pnpm-lock.yaml`을 입력에 포함한다. 이미 캡처한 입력 파일을 산출 디렉터리 아래에 둘 수 없다.

격리 명령은 사본·시스템·실행 도구 경로만 읽는다. 별도로 설치한 pnpm 등의 도구는 `config.runtimePaths`에 절대 경로로 선언하며 이 구성도 fingerprint에 포함한다. 실행 도구 경로는 신뢰하는 설치 위치여야 하고 원본 프로젝트를 포함할 수 없다. 외부 하드링크가 있는 입력은 거부한다. 임시 파일은 사본 안의 예약 디렉터리 `.forge-gate-tmp`를 사용하고 `OPENSSL_CONF`는 `/dev/null`로 고정해 사용자 전역 설정을 입력으로 읽지 않는다. Linux는 호스트 전체를 연결하지 않고 시스템 도구·명시한 실행 도구와 사본만 연결한다.

`format: "tap"`은 stdout을 TAP으로 해석한다. `format: "exec"` 또는 `"module"`의 기본 텍스트 출력은 종료 상태를 판정하며 수용 기준을 자동으로 주장하지 않는다. `resultFormat: "json"`이면 stdout에 `{ "ok": true, "covers": ["AC-1"] }` 형태의 결과를 출력한다. 종료 상태는 항상 제어면이 관찰한 실제 프로세스 상태를 사용한다. macOS는 시스템 sandbox, Linux는 Bubblewrap을 사용하며 격리 수단이 없거나 사본을 검증할 수 없으면 통과로 기록하지 않는다. 정확한 공개 실행 예는 [격리 수용 테스트](../scripts/gate-acceptance.test.mjs)와 [증거 모듈](../scripts/lib/evidence.mjs)에 있다.

프로젝트에 `typecheck` 또는 `build` package script가 없으면 `describe`는 fingerprint 입력에 `package.json`을 포함하고 `applicability: {state: 'not-applicable', reason, evidencePath: 'package.json'}`을 제공할 수 있다. 제어면은 설명된 설정이 실제 프로젝트의 `package.json`과 일치하는지 확인하고 캡처한 설정에서 script 부재를 직접 판단한다. 실제 설정 파일을 근거로 `not-applicable`을 기록하며 어댑터의 성공 주장을 사용하지 않는다. 이는 통과 증거가 아니고 수용 기준을 커버하지 않으며 정확한 대상의 독립 리뷰가 있어야 수용된다. 그 밖의 게이트, 설정된 명령, 실패한 적용 여부 검사 및 미충족 기준은 이 경로로 면제되지 않는다.

세션 연결에는 패키지의 `scripts/lib/session-runtime.mjs`가 `createSessionRunner({runtime,command,parent,launch,runtimeRpc,taskTransport,taskPrompt})`를 제공한다. `runtime`은 `cmux` 또는 `orca`; `parent`는 실제 `sessionId`, `incarnationId`, `cwd`; `launch`는 승인된 후속 실행 argv를 만든다. Orca는 설치된 CLI와 함께 제공되는 런타임 클라이언트의 `terminal.inspectProcess`를 사용한다. 명시적 `runtimeRpc`가 있으면 대신 사용한다. 제공자는 기본 클라이언트의 발견·호환성·수명을 소유하며 번들 클라이언트는 각 요청의 연결을 호출 후 해제한다. 번들 클라이언트가 없거나 관찰 계약이 달라지면 실행은 실패 상태로 남는다. 호스트 화면이나 입력 전송만으로 실제 착수를 선언하지 않는다.

Orca가 자동 생성한 제목으로 터미널 이름을 바꾸더라도 Claude는 정확한 native session ID로, Codex는 native 대화의 정확한 초기 요청으로 기존 worker를 찾는다. 화면 탭에 연결되지 않은 터미널은 연결·쓰기 가능 상태와 native incarnation, 프로세스·cwd 및 요청 영수증이 일치할 때만 인정한다. 관찰 중 탭 연결 상태가 바뀌거나 후보가 중복되면 재기동하지 않고 미확정으로 남긴다.

목표에 연결된 세션은 `goal create`로 목표와 정본 해시를 등록하고 `unit session-start`로 시작한다. 정책의 `session`에는 runtime, provider, account 설정 디렉터리, model, effort, argv를 명시하며 역할별 재정의는 `session.roles`에 둔다. 네이티브 목표에는 전체 목적, 남은 단위, 불변 인계와 종료 스킬이 포함된다. 단위가 끝나면 `unit finish`, 실제 외부 차단이면 원인 기록 후 `unit session-stop`, 독립 리뷰 반환이면 `unit session-return`을 사용한다. 효과가 불확실할 때는 기존 식별자로 `unit finalize`를 재개한다. 목표의 최종 완료는 각 완료 기준에 대한 수용 증거가 필요하다.

이 연결은 별도 신뢰 가능한 세션 어댑터 설정을 필요로 한다. Claude의 기존 cmux 수신자는 빈 입력란과 프로세스 신원을 다시 확인한 후 짧은 결과 참조를 제출하며, 네이티브 기록에서 각 인계 파일의 읽기 결과가 일치해야 수신을 확정한다. 참조가 화면 한 줄에 들어가지 않거나 입력란을 안전하게 식별하지 못하면 대기 상태를 유지한다. 관리 세션의 Stop 훅은 미완료 작업과 미확인 인계를 확인해 계속 진행하도록 요청한다. 호스트의 훅 사용·신뢰 설정이 적용되어야 실행되며 사용자 중단을 가로채지 않는다. 반복 방지를 위해 이미 훅으로 재개된 응답에서는 재차 중단을 차단하지 않고 미완료 상태를 알린다. 훅 상태를 관찰할 수 있는 작업자(Codex)는 수신 영수증에 검증된 Stop 훅 강제가 있어야 시작이 인정되고, 관찰 수단이 없는 작업자(Claude)는 호스트에서 활성화되고 신뢰된 Stop 훅에 기댄다.

관리 세션은 `/goal` 명령으로 네이티브 목표를 설정하고 별도 제출한다. 일반 초기 prompt나 입력 전송만으로 목표 활성이나 작업 착수를 판정하지 않는다. 기본 Codex transport는 worker PID의 열린 native writer lock으로 thread를 결속한다. 같은 프로세스에 여러 lock이 있으면 native metadata의 source가 cli 또는 exec이고 cwd가 일치하는 유일한 주 thread를 선택하며 subAgent는 제외한다. 별도 `codex app-server --stdio`의 `thread/read`, `thread/turns/list`, `thread/queue/list`로 실제 기록을 읽는다. 지원 프로토콜은 설치된 CLI가 제공해야 하며 누락 시 차단된다. cmux의 기존 owner 결과 전달은 짧은 불변 packet 참조를 인식된 빈 composer에 붙여 넣고, 두 번의 동일한 settled 관찰과 worker/thread 재확인 뒤 별도 Return으로 제출·steer한다. 다른 초안·modal·미지원 화면에는 입력하지 않는다. 의미 있는 공백은 보존하고 복원할 수 없는 줄바꿈 composer는 거부한다. 짧은 결과 참조를 사용하며, 화면 폭이 부족하면 미완료로 남는다. 이미 정확한 composer가 있으면 재붙여넣지 않는다. native exact userMessage와 그 뒤 실제 packet 읽기·실행 항목으로만 수신을 확인한다. 읽기 증거는 native read action 또는 일치하는 파일 경로·digest의 checksum 출력과 실제 packet 본문이다. cmux 이외의 기본 경로는 native queue를 사용하며 대기만으로 완료되지 않는다. 이전 버전의 전체 본문 전달 prompt는 먼저 읽기 전용으로 관찰하여 이미 접수된 요청을 재제출하지 않는다. 앱 서버 기록을 읽는 프로세스는 기존 thread를 resume하거나 탈취하지 않는다.

Codex 네이티브 목표는 해당 계정의 `goals_1.sqlite`에서 결속된 thread의 `thread_goals` 행을 읽기 전용으로 관찰한다. 별도 app-server에 라이브 thread를 로드하지 않으며 원본 데이터베이스를 수정하거나 생성하지 않는다. 저장소 또는 스키마가 지원되지 않으면 차단한다. 목표가 없는 새 thread는 writer lock·프로세스·cwd 결속 아래에서 목표 부재를 반환하고, 목표가 있으면 전체 objective가 의도한 문구와 정확히 일치하는지 확인하고 실제 활동 기록과 패킷 읽기를 추가 확인한다. active 또는 이미 complete인 목표만 수신 근거가 되며 완료 상태만으로 작업 착수를 인정하지 않는다. 패킷 읽기 뒤 같은 turn의 별도 성공 명령이 출력한 경로·checksum도 실제 본문 읽기와 결속할 수 있다. 참조 경로는 검증된 worker cwd를 기준으로 해석하며 반복되는 절대 경로를 목표 입력에 중복하지 않는다. cmux 새 수신 창은 tty와 입력 화면이 관찰 가능한 활성 상태로 연다. 긴 목표는 작은 입력 묶음 사이의 처리 시간을 두어 붙여넣기 블록으로 접히는 것을 방지하며, 화면과 입력이 일치하기 전에는 Return을 보내지 않는다.

다른 worker는 명시적 `taskTransport`를 등록한다. `observe({observed,input,prompt,packets})`는 `startup|modal|ready|prefilled|queued|accepted|started`와 네이티브 근거를 반환한다. `started`에는 promptDigest·threadId·requestId·turnId·activityId·packets가 필요하다. `submit({...request,fence})`는 같은 native readiness fence에서 정확한 입력만 조건부 제출한다. interactive pending 입력의 Enter와 busy 입력의 steering/queue는 이 transport가 처리한다. 화면은 composer 준비 관찰에만 쓰고 승인·수신 증거로 쓰지 않는다. cmux는 원자적 composer API가 없으므로 native identity와 정확한 화면을 입력 전 재검사하며 receipt를 별도로 검증한다. `identity(observed)`는 실제 worker의 threadId를 반환한다. `taskPrompt(args,argv)`는 초기 prompt 형식이 다른 worker에만 필요하다.

승인된 다음 작업을 같은 세션에서 계속할 때 finish 요청의 `sameSession: {approved: true, nextUnit: "<unit>"}`을 사용한다. 이 경로는 단위 결과·남은 일·다음 작업을 기록하고 단위만 닫으며 session start·deliver·close나 종료 finalizer를 만들지 않는다. 전체 목표 완료나 실제 인계와 함께 요청할 수 없다.

자동 종료에는 `parent.workerExecutable`과 `parent.closable: true`가 필요하다. incarnation은 해당 worker의 실제 관찰값이며 wrapper 셸의 PID로 대체하지 않는다. 같은 세션에서 다음 작업을 계속하면 `unit finish`는 결과와 남은 목표를 기록하고 단위를 닫으며 세션 기동·전달·종료 효과를 만들지 않는다. 실제 이전이나 허용된 worker 종료를 위한 finalizer가 필요하면 결과/인계를 고정한 뒤 분리된 finalizer를 기동한다. 그 로그는 `<stateRoot>/units/<unit>/finalization.log`다. 결과를 아직 전달하지 못했거나 수신을 관찰하지 못하면(예: 수신 세션이 바빠 입력란이 비지 않음) 분리된 finalizer가 같은 의도를 최대 2시간 동안 30초 간격으로 다시 관찰한다. 손으로 돌릴 때는 `unit finalize <unit> --wait <초> [--interval <초>]`를 쓴다. finalizer만 결과 수신·착수, close intent, 정확한 worker 신원, 종료 뒤 부재를 확인하고 Closed를 기록한다. `returnTo: {sessionId,incarnationId,cwd,executable}`를 주면 기존 parent로 결과를 돌려보낸다. 수신이 지연되거나 종료가 불확실하면 같은 `unit finalize <unit> --adapters <module>` 또는 원래 finish를 재호출한다. 전체 목표 완료 또는 수신자 없는 차단·일시중지는 successor를 만들지 않고 결과와 재개 조건을 기록해 사용자에게 보고한다. 초기 session.start의 unit·role·attempt·args·key는 변경하지 않는다. 기존 원장·결과 파일을 새 필드에 맞춰 직접 수정하지 않는다.

반환 의무는 tracker 투영 전에 저장되며 public close/reconcile도 이를 우회하지 못한다. 구버전 process-only result는 같은 seq/key의 실제 native 재관찰로 보강하고 원 행을 남긴다. cmux의 마지막 surface 종료에는 종료된 빈 placeholder surface를 먼저 만든다. workspace 전체 종료는 사용하지 않으므로 동시에 추가된 다른 surface는 유지된다. 종료 뒤 해당 workspace에는 빈 surface가 남을 수 있다.

활성 단위의 전달 또는 리뷰 정책 변경은 `unit policy change <unit> --request <file> --user-input <ref>`를 사용한다. 요청은 `id`, `expectedRevision`, `reason`과 `delivery` 또는 전체 `review: {mode, by, triggers}` 중 하나를 포함한다. 신뢰된 `provider.verifyUserInput`은 정확한 요청 digest와 이전·새 정책 값, 사용자 입력 출처를 검증한다. 리뷰 값은 JSON 문자열로 전달한다. 제출된 SelfGated 또는 Accepted 단위만 변경할 수 있으며 진행 중 단계·전달 계획·세션 종료나 불확실한 효과가 있으면 차단한다. 변경 이력에는 이전 정책·수용·리뷰와 승인 출처가 남고 기존 작업·증거·효과는 유지된다. 이전 수용은 무효화되므로 같은 단위를 다시 수용해야 한다. 동일 요청의 재시도는 기존 결과를 반환한다. 전달 정책을 변경한 단위의 finish는 변경된 전달 수준을 기본으로 사용하며, 다른 수준은 먼저 명시적 정책 변경을 거쳐야 한다. 이미 시작된 finish와 효과는 실행 직전 단위 잠금 안에서 현재 정책과 수용 대상 또는 작업 상태를 다시 검사하며 이전 권한으로 진행하지 않는다.

merge 전달은 시작할 때 원장의 기존 intent 경계를 고정한다. 중단 후에는 해당 전달에서 기록한 정확한 PR과 merge intent를 원격 상태 및 원장 결과와 대조해 재개한다. 이미 병합된 대상의 PR 생성이나 merge를 다시 실행하지 않는다. 이전 형식의 진행 중 전달처럼 경계를 증명할 수 없거나 원래 merge intent가 없는 병합은 새 효과를 만들지 않고 확인을 요구한다.

전달 문맥은 `resourceOwned`, `productOwned`, `inScope`, `operational`, `irreversible`, `containsSecret`, `forbiddenCommand`의 boolean을 제공한다. 사용자 지시는 신뢰된 제공자가 검증하며 요청 파일의 자기 신고로 승격하지 않는다. 등록 실패는 구조화된 RESULT로 나오고 필수 제공자가 없는 연산은 차단된다.

전체 계약: [명세 §7·§8](spec.md#7-스킬-구성과-계약). 런타임 경계: [runtime-adapters.mjs](../scripts/lib/runtime-adapters.mjs). 외부 호출 진입점: [adapters.mjs](../scripts/lib/adapters.mjs).

`unit.scope.approval.correct`와 `unit.goal.bind.recover`의 원 사람 승인·직전 차단 문맥·정확한 요청 및 현재 대상 결속은 [승인 출처·goal 결속 복구](goal-binding-recovery.md)를 따른다. 운영 메시지가 user 역할로 저장됐다는 사실만으로 사람 권한을 인정하지 않는다. 출처 정정은 원 승인 행을 보존하고, goal 결속은 기존 native 소유자 검증을 대신하지 않는다.

동일 단위 검증 방식 정정의 정확한 제공자 입력·응답·증거 계약은 [검증 정정](acceptance-recovery.md#제공자-계약)에 정의한다. 사용자 입력 참조의 형식·원 저장소 접근은 호스트 제공자가 소유하며 코어는 특정 세션 제공자의 참조를 변환하거나 다른 출처로 대신 승인하지 않는다. 미지원 참조 형식은 승인 실패다. acceptance-coverage 제공자는 전달된 제품 기준 투영과 실제 제품 증거를 사용한다. 다른 HEAD의 경로 선택이나 미검증 ID 일괄 성공으로 누락을 숨기지 않는다.

미수신 재시도는 native history/queue에 요청이 없고 정확한 입력이 composer에 남아 있을 때만 정책 상한 안에서 같은 intent로 Enter를 재개한다. 빈 composer나 단순 조회 실패로는 미제출을 추정하지 않는다.

진행 중인 목표의 실행 정책은 등록 시점에 고정된다. 사용자가 승인한 작업 정책 변경(예: 리뷰 역할)은 `goal policy-refresh <id> --request <file> --user-input <ref> --adapters <module>` 로만 목표에 반영한다. 요청은 `expectedRevision`·`reason` 을 담고, 신뢰된 `provider.verifyUserInput` 이 정확한 승인을 확인한다. 이전 실행 정책은 `policyChanges` 에 남고, 이후 시작하는 단위가 새 정책으로 결속된다. 같은 정책이면 바꾸지 않는다.

명시적 범위 축소의 정확한 `verifyAcceptanceChange` 계약은 [승인된 기준 제외](criteria-changes.md)에 정의한다. 분류 정정 검증으로 제품 요구 제외 권한을 대신하지 않는다.

기존 사용자 소유권 등록은 [기존 소유자 복구](session-custody-recovery.md)의 `verifySessionAdoption` 및 `session.observe({recipient,nativeOwner:true})` 계약을 따른다. 현재 목표 정책과 과거 단위 정책의 세션 설정은 구분하며 실제 수신자의 native 신원은 `recipientEnv`로 확인한다.

관리 session.start의 `input.submission`은 제어면이 제공하는 동일 intent의 영속 제출 경계다. session runner는 이 in-process context를 execute/verify에 보존하고 최초 입력 전에 비동기 mark를 기다린다. [동일 수신자 복구](native-goal-recovery.md)의 부재·재호출·관찰 전용 계약을 따른다.

실행 정책 변경 후 기존 session.start를 관찰할 때 패키지 어댑터는 원 intent snapshot의 계정을 사용한다. [정책 변경 기동 복구](session-policy-recovery.md)는 `provider.verifySessionStartRecovery`의 읽기 전용 native 미착수·종료·큐 취소 증명과 `verifyUserInput`의 정확한 승인을 요구한다. 기본 어댑터는 이 권한 검증을 추정하지 않는다. 예약 명령은 새 worker를 만들지 않으며 다음 session-start가 예약된 snapshot으로 실행한다.

Codex 0.167.0의 첫 입력 전 rollout은 아직 파일이 아닐 수 있다. 이 경우 별도 observer의 정확한 미로드 오류, 실제 worker가 연 queue SQLite root의 읽기 전용 queue/goal 검증, 원 managed 기동·동일 native 신원·미제출 intent, 전체 fresh Ready 화면을 결합한 `unmaterialized` 상태만 최초 입력 후보가 된다. 일반 조회 실패는 empty가 아니며 실제 목표·패킷·착수·훅 검증을 대체하지 않는다.

사전 Return composer 실패가 기록된 동일 submission은 전체 정확한 pending draft만 재입력 없이 재개한다. 알려진 첫 burst 슬래시 소실은 기본 입력 정책까지 검증한 별도 `draft-repair` 경계로만 정정하며, 검증된 raw03 한 번으로 전체 nonempty textarea를 취소하고 실제 empty를 관찰한다. 성공 응답만으로 키 전달·전체 clear를 추정하지 않는다. 구 경로의 실패한 clear는 같은 binding·정확한 손상 원문·실패 기록을 검증한 단일 `draft-clear-recovery` 경계로만 재개하고 원 marker를 보존한다. 최초 인자가 실제 화면에 정착한 뒤 나머지를 입력하며, `confirmation` 경계를 동기화한 뒤 Return을 한 번만 보낸다. 새 경로의 불확실한 clear·Return은 반복하지 않는다.
