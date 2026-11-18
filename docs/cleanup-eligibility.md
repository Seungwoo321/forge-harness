# 호스트 정리 자격

`unit cleanup-check <unit> --request <file>`은 호스트가 worktree·branch·원격 ref를 삭제하기 전에 정본 생명주기를 읽기 전용으로 판정한다. 요청은 다음 필드만 가진다.

```json
{"unit":"change","expectedRevision":41,"expectedGoalRevision":15,"repo":"owner/repo","branch":"feature/change","worktree":"/abs/worktree"}
```

자격 조건은 다음과 같다.

- 단위는 목표에 결속된 change 단위이고 Closed이며, 목표는 complete이고 남은 단위가 없으며 그 최종 단위다.
- `accepted.repo`·`accepted.branch`가 요청과 같고, worktree의 실제 경로가 최종 소유자 cwd와 같다.
- 최종 소유자는 유지(ownerRetained)되지 않았고, 원장에 그 정확한 session·incarnation의 `session.close` 결과 `closed:true`가 있다.
- 단위 원장에 미해결 효과가 없고, 목표의 모든 리뷰 단위가 close 영수증과 함께 Closed이며 미해결 효과가 없다.
- 상태 저장소(stateRoot)가 삭제 대상 worktree 밖에 있다.

성공 결과는 `eligibility.eligibilityDigest`를 반환한다. 호스트는 각 삭제 직전에 같은 요청으로 다시 판정해 같은 digest를 요구한다. 다른 결과나 거부(`CLEANUP_INELIGIBLE`, `CLEANUP_REQUEST_INVALID`)는 삭제하지 않는다. 판정은 정본을 바꾸지 않으며 삭제·삭제 영수증·재시도 정합화는 호스트가 소유한다. 비관리 작업은 호스트의 별도 정책을 따른다.

설계 근거: [ADR 0065](adr/0065-host-cleanup-eligibility.md).
