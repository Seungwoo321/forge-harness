# Claude 관리 기동의 첫 관찰 실패 뒤 같은 수신자 재조정

## 문맥

Claude 관리 기동은 첫 입력 전에는 트랜스크립트를 만들지 않는다. 지금까지 트랜스크립트 부재는 driver 의 최초 실행 경로에서만 입력 부재로 인정했고, 재생(recovery)에서는 거부했다. cmux 가 새 터미널을 아직 나열하지 않아 첫 관찰이 실패하면, 같은 intent 의 이후 재생은 모두 recovery 가 된다. 그 결과 아무 입력도 받지 않은 정확한 수신자가 있는데도 시작이 영구히 uncertain 으로 남았다. Codex 는 pre-turn sqlite 증명이 있지만 Claude 에는 대응 경로가 없었다.

## 결정

Claude 관리 기동의 `--session-id` 는 effect key 와 goal digest 에서 결정적으로 유도된다(`scripts/lib/continuity-launch.mjs`). recovery 재생은 다음을 모두 만족할 때 트랜스크립트 부재를 입력 부재로 인정한다.

- 같은 intent·seq 에 `submission` 행이 없다. 하네스의 모든 입력은 이 durable 행을 먼저 쓰므로, 행이 없으면 하네스 입력도 없다.
- 관찰한 살아 있는 프로세스의 `--session-id` 가 이 intent 의 실행 정책에서 유도한 값과 같다.
- 그 세션의 트랜스크립트가 없다.
- 첫 입력과 Return 직전의 기존 확인(같은 프로세스·스레드, 빈 Ready composer, recovery 준비 검사)이 통과한다.

## 제외한 방법

첫 관찰의 cmux 나열 경합만 재시도로 줄이는 방법은 이미 uncertain 이 된 intent 를 복구하지 못한다. 새 작업자 기동, intent 교체, 원장 수정, 트랜스크립트 합성은 하지 않는다. 다른 세션 id 나 `submission` 행이 있는 경우는 계속 거부한다.
