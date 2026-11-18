# Adoption과 목표 변경의 승인 출처 정정

`unit session-approval-correct <unit> --request <file> --user-input <original-human-ref> --adapters <module>`은 현재 소유권의 원 `adoptions` 영수증을 지정한다. `goal approval-correct <goal> --request <file> --user-input <original-human-ref> --adapters <module>`은 같은 목표의 원 `amendments` 영수증을 지정한다. 두 명령은 원 행을 변경하지 않고 목표의 `authorityCorrections`에 정정 영수증을 추가한다. 소유권과 목표 의미, 단위의 모든 바이트, 실패·증거·수용·리뷰는 유지한다. 소유권 교체, 철회나 목표 의미의 롤백은 출처 정정이 아니다.

현재 대상의 두 요청은 다음 필드만 가진다. 구조 digest는 `effectArgsDigest`를 사용하고 원 영수증은 전체 행을 해시한다. `provenance.ref`는 실제 원 대화와 오류 문맥을 담은 불변 파일의 절대 경로이고 digest는 그 파일 바이트의 해시다. 제어면은 그 바이트를 문맥 검증 전후에 직접 대조한다. 의미상 원 사람 지시를 가리키는 userInputRef는 별도로 유지하며 제공자가 실제 원 대화와 대조한다. 파일이 아닌 provenance locator는 허용하지 않는다.

```json
{
  "id":"authority-source-1",
  "unit":"change",
  "expectedRevision":36,
  "expectedGoalRevision":7,
  "unitDigest":"sha256:<complete current unit>",
  "goalDigest":"sha256:<complete current goal>",
  "targetDigest":"sha256:<live Git inspection>",
  "original":{"index":0,"digest":"sha256:<complete original adoption or amendment>"},
  "provenance":{"ref":"/evidence/conversation.json","digest":"sha256:<immutable conversation source>"},
  "reason":"Correct the operator attribution from the original human instruction"
}
```

대상은 active 목표의 첫 남은 변경 단위이며 Scoped/Implementing/SelfGated/InReview/Accepted 상태이고 전달·종료가 시작되지 않아야 한다. 목표 변경 정정도 같은 현재 단위와 native 소유권에 결속한다. 실제 현재 소유자 cwd에서 실행한다. adoption 정정은 지정한 원 adoption이 현재 custody일 때만 허용하며, superseded 소유권을 복원하지 않는다. native 신원은 기존 session custody의 runtime·session·incarnation·cwd·worker executable/pid/incarnation/thread와 정확히 같아야 한다. 현재 목표 실행 정책의 runtime/provider도 일치해야 한다.

신뢰된 읽기 전용 `provider.verifyUserInput`은 다음 binding과 `effect`, `reason`을 받아 같은 필드와 `verified:true`를 반환한다. effect는 각각 `unit.session.approval.correct`, `goal.approval.correct`다.

- `unit`, `goalId`, `userInputRef`, `kind` (`adoption` 또는 `amendment`)
- `argsDigest`: `{kind,request,userInputRef}`의 digest
- `unitDigest`, `goalDigest`, `targetDigest`, `originalDigest`, `previousUserInputRef`
- `ownerDigest`: 현재의 정확한 `nativeOwner` 신원 digest
- `policyDigest`: 현재 목표 실행 정책 digest
- `sourceDigest`: goal.source, provenance 파일, 종료 대상의 resultRef와 completionProof 파일, cwd 기준 절대 경로로 정규화한 unit.canon 순서의 배열 전체 digest
- `provenanceDigest`: 요청한 원 대화 출처 digest

별도 필수 `provider.verifyAuthorityCorrection`은 위 binding과 `request`, `record`, `goal`, `original`, `result`, `owner`, `target`을 받는다. 같은 binding과 `verified:true`가 있어야 한다. `result`는 목표 변경의 실제 결과인 `{objective,criteria}`이며 adoption에는 null이다. 이전 amendment의 결과는 다음 amendment의 `previous`에서, 마지막 amendment의 결과는 현재 goal에서 결정한다. 정확한 재호출의 `goal`은 원 요청 snapshot이다.

제공자는 실제 원 사람 메시지와 직전 보고·적용 정책을 읽고 원 참조가 사람 승인을 잘못 귀속했다는 사실과 새 참조가 정확히 보존되는 원 operation을 허용한다는 사실을 확인한다. 승인 대상, 기존 operation 및 현재 상태를 모두 검증한다. 역할 이름, 전달된 운영 문구, 요청 파일의 자기 신고 또는 digest 반사만으로 승인하지 않는다. 출처의 실제 바이트가 provenance digest와 일치하는지도 제공자가 확인한다. 일반 승인을 검증하는 함수만 있고 문맥 검증기가 없으면 차단한다.

제어면은 원장→단위→목표 잠금 안에서 검사하고 목표의 원자적 commit까지 유지한다. 원장에 미해결·unknown·uncertain 효과가 있으면 먼저 reconcile한다. goal.source·provenance 파일·unit.canon의 바이트, Git 대상과 실제 native 소유권을 제공자 호출 전후에 확인한다. 마지막 비동기 native/이력 관찰까지 완료하고, 현재 대상은 live Git digest도 새로 대조한 뒤 append 또는 중복 반환 직전에 모든 불변 출처 바이트를 다시 대조한다. 관찰을 기다리는 동안의 변경도 거부한다. 승인·소유권·task/transfer/close 성공 영수증을 합성하지 않는다.

정정 영수증은 원 행 전체, 원 목표 변경의 결과 정의, 실제 사람 참조, 요청, binding digest와 목표 revision을 남긴다. 같은 id와 정확한 payload는 같은 기준 상태·출처·현재 소유권을 다시 검증하고 중복 없이 반환한다. 정정 뒤 목표나 단위가 바뀌면 이전 요청 재호출도 거부한다. 같은 id의 다른 payload와 같은 원 영수증의 추가 정정, 잘못된 목표·원 행·현재 대상, source drift와 경합은 정본을 바꾸지 않는다. 기존 adoption replay/rebind 및 goal amend 계약은 그대로 유지한다.

완전히 종료된 대상에는 동일 요청에 `completionProof: {ref,digest}`를 추가한다. ref는 이력 증거 파일의 절대 경로이고 digest는 그 바이트 해시다. Closed 단위와 complete 목표의 최종 단위가 같고, 단위의 goalCompletion과 목표의 completion proof가 일치하며, 단위의 head/contentFingerprint가 원 accepted 대상과 같아야 한다. 이 경우 targetDigest는 현재 Git 상태 대신 원 accepted 객체 전체의 digest다. resultRef의 실제 파일과 completionProof도 source 검증에 포함한다. active 목표나 부분 종료 상태에는 이 경로를 쓰지 않으며, 현재 대상 요청에는 completionProof를 허용하지 않는다.

종료 대상은 현재 프로세스나 Git 조회 대신 필수 읽기 전용 `provider.verifyCompletedAuthorityTarget`을 사용한다. 위 binding 및 `record`, 원 요청 snapshot인 `goal`, `owner`, `target`, `completionProof`, `ledger`를 받고 같은 binding과 verified:true를 반환한다. binding에는 모든 경로에서 `mode`(live/completed)와 `completionDigest`가 추가된다. live의 completionDigest는 null이며 completed에서는 `{completion:goal.completion,goalCompletion:record.goalCompletion,resultRef:record.resultRef,completionProof:request.completionProof,ledger}`의 digest다. policyDigest는 custody에 기록된 정책(없으면 목표 정책)에 결속한다. 제공자는 실제 이력 파일과 수용된 소스 대상, 당시 정확한 native 신원과 실제 종료 또는 유지 처분을 대조한다. 현재 PID 부재나 Closed 표기만으로 증명하지 않는다. 역사 검증과 출처 파일 검사는 문맥 검증 전후에 반복한다. 원 단위 바이트·완료 proof·전달·custody·게이트·리뷰·실패는 그대로 두고 목표의 감사 행만 추가하며 실행·재개·종료 권한을 만들지 않는다.

설계 근거: [ADR 0062](adr/0062-correct-goal-authority.md).
