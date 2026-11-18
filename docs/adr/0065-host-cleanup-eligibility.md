# 호스트 자원 삭제 전 정본 정리 자격

## 문맥

호스트의 자원 정리기는 병합된 PR·미커밋 변경·원격 ref·화면 상태로 worktree·branch를 삭제할 수 있다. 이 신호는 관리 생명주기의 완료와 같지 않다. InReview 단위와 살아 있는 원 소유자, 진행 중인 목표가 남아 있어도 병합된 기능은 정리 대상으로 보인다.

## 결정

공개 읽기 전용 `unit cleanup-check <unit> --request <file>`이 정리 자격을 판정한다. 요청은 단위, 기대 단위·목표 revision, accepted repo·branch와 삭제할 worktree 절대 경로를 모두 지정한다. 자격은 목표가 complete이고 그 최종 단위가 Closed이며, 최종 소유자의 정확한 close 결과가 원장에 있고, 소유자 유지가 없고, 미해결 효과가 없고, 목표의 모든 리뷰 단위가 close 영수증과 함께 Closed일 때만 성립한다. worktree는 최종 소유자 cwd와 같아야 하고 상태 저장소는 삭제 대상 밖에 있어야 한다.

판정은 원장·단위 잠금 아래 수행하고 정본을 바꾸지 않는다. 결과의 `eligibilityDigest`는 요청과 단위·목표·원장·리뷰 상태를 결속한다. 호스트는 각 파괴 단계 직전에 같은 요청으로 다시 판정하고 같은 digest를 요구한다. 거부는 `CLEANUP_INELIGIBLE` 또는 `CLEANUP_REQUEST_INVALID`로 닫힌 쪽에 실패한다.

## 제외한 방법

병합된 PR, 작업관리 완료, Ready 화면, PID 부재, 원격 ref 부재는 자격이 아니다. 비관리 작업에 Closed 상태를 합성하지 않으며 그 정리는 호스트의 별도 정책이 정한다. 삭제 자체와 삭제 영수증은 호스트가 소유한다.
