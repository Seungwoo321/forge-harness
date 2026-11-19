# 영속 생명주기 감시

`node scripts/unit.mjs unit watch add --request watch.json`은 현재 목표의 custody에 묶인 감시를 등록하고 실행기를 자동 기동한다.
`--state-root`는 다른 단위 명령과 같은 저장소를 가리킨다. 기본값은 Git common directory 아래 `work-state`다.

요청 JSON 필드:

| 필드 | 계약 |
| --- | --- |
| `id`, `goalId`, `unit` | 경로에 안전한 식별자 |
| `custodyDigest` | 현재 `goalOwner(goal, unit)`의 `effectArgsDigest` |
| `recipient` | `nativeOwner`가 반환하는 runtime/sessionId/incarnationId/cwd/worker 전체 신원 |
| `account` | 수신자 Codex 계정의 절대 디렉터리 |
| `everyMs` | 1000 이상 정수 간격 |
| `expiresAt` | 유한한 만료 시각, epoch milliseconds |
| `maxRuns` | 재시작을 포함한 총 전송 시도 예산, 양의 정수 |
| `prompt` | 승인된 다음 행동을 설명하는 1600자 이하 문자열 |
| `condition` | `{argv: [executable, ...args], cwd: absoluteDirectory}` |

조건 명령은 15초 안에 `{ "state": "stable-condition-fingerprint", "actionable": true }` JSON과 exit 0을 반환한다.
`state`에는 CI/review 등 의미 있는 상태만 포함한다. 시각·호출 횟수를 넣지 않는다. 명령은 기계적인 읽기만 하며 모델을 호출하지 않는다.
등록 시 현재 상태가 기준선이다. 이후 actionable 상태 변화만 깨운다. Working·native queue 대기·사용자 draft가 있으면 변화는 다음 회차로 보류한다.
현재 검증된 backend는 Codex native queue다. cmux와 Orca의 정확한 수신자 검증을 거친 기존 thread에만 전송한다. 새 모델 세션은 만들지 않는다. 같은 account·cwd의 필수 플러그인 훅이 현재 trusted/managed일 때만 전달한다.

공개 명령은 `unit watch list`, `pause ID`, `hold ID`, `resume ID`, `remove ID`, `reconcile ID`, `status`다.
각 명령은 보류 감시가 있고 실행기가 없으면 자동 복구한다. pause/HOLD는 저장되며 명시적인 resume 전에는 깨우지 않는다. 정본 목표·단위의 실제 차단도 HOLD로 보존한다.
`status`는 실행기 진단과 저장된 영수증을 출력한다. 사용자가 실행기를 따로 시작하거나 OS 서비스를 등록하지 않는다.
활성 감시가 0개면 실행기는 종료한다. 부팅·강제 종료 후에는 다음 SessionStart 또는 감시 명령이 실행기를 복구한다.
놓친 회차는 현재 시각에서 한 회차로 병합한다.

감시는 `<state-root>/watches/store.json`에 원자 교체와 fsync로 저장한다. 저장소 잠금과 실행기 잠금은 기존 OS advisory lock 어댑터가 제공하며 프로세스 종료 시 해제된다.
다른 호스트의 실행기이거나 PID가 살아 있거나 존재 여부가 불명확하면 교체하지 않는다. 죽은 PID만 자동 복구한다.
계정 디렉터리의 `lifecycle-watches`에는 thread별 수신자 소유권 포인터와 잠금을 저장하여 저장소 간 중복도 차단한다.
잠금 순서는 감시 저장소 → 수신자 → 효과 원장 → 단위 → 목표다. custody 검증부터 전송까지 단위와 목표 잠금을 유지한다.
전송 전 intent·횟수 예산·`session.wake` 효과 원장 기록을 저장한다. 실제 native turn 시작 확인은 전송 효과를 정합화하며, 원래 turn의 종료 관찰은 별도 결과로 보존한다. 영수증은 intent, submitted, transport-accepted, turn-started, result를 구분한다.
result는 해당 native turn의 종료 상태이며 목표나 단위 완료 증명이 아니다.
전송 중 실패·프로세스 종료로 생긴 pending은 자동 재전송하지 않는다. `reconcile`은 원래 key의 큐와 thread 기록만 조회한다.
관찰로 이미 수락된 프롬프트는 pause/remove로 회수하지 않는다. 원래 요청의 실제 턴 종료를 확인하기 전에는 후속 전송을 막는다. 만료·제거·pause 뒤 남은 pending은 명시적 `reconcile`로 관찰한다. 만료·예산 소진·바뀐 custody·종료 단위는 깨우지 않는다.
정상 전달·finalization이 완료된 뒤 해당 단위와 수신자의 감시만 제거한다. 영수증은 진단을 위해 보존한다.

외부 스케줄러의 기본 저장소와 `AGENT_SCHEDULER_HOME`으로 선택한 저장소를 읽기 전용 검사한다. 같은 thread/account 또는 cmux surface 감시가 있으면 등록과 전송을 거부한다.
외부 저장소가 다른 위치에 있으면 해당 환경 변수를 지정한다. 등록 당시 경로도 감시에 보존하여 재기동 환경이 달라도 충돌을 검사한다. 현재 감시의 ID·pending·예산·pause를 이전하거나 삭제하지 않는다.
외부 도구를 통해 새 감시를 추가할 때도 이 중복 금지 규약을 따라야 한다. 그 도구의 임의 직접 쓰기까지 통제하지 않는다.
설치·릴리스·기존 live monitor 변경은 감시 등록 명령의 역할이 아니다.
