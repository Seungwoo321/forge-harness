# Adoption·목표 변경 승인 출처의 별도 정정 기록

## 문맥

운영자 지시가 기존 소유자 adoption이나 목표 변경의 사람 승인으로 잘못 기록될 수 있다. adoption replay는 다른 승인을 거부하고, rebind는 실제 교체 프로세스를 요구한다. 같은 값의 goal amend는 원 오류를 지목하지 않고 의미 이력을 추가한다. 세 경로 모두 출처를 정정하지 않는다.

## 결정

공개 `unit session-approval-correct`와 `goal approval-correct`는 원 목표에 승인 출처 정정 기록을 추가한다. 요청은 원 adoption 또는 amendment 행 전체를 index와 digest로 지정하고, 현재 단위·목표·실측 Git 대상·불변 출처·native 소유자를 결속한다. 신뢰된 읽기 전용 문맥 검증기가 원 귀속이 잘못됐다는 사실과 실제 사람 지시가 보존된 operation을 정확히 허용한다는 사실을 확인한다. 메시지 역할과 요청 파일의 자기 신고만으로는 승인하지 않는다.

원장·단위·목표 잠금이 검증과 목표의 원자적 commit을 감싼다. 미해결 효과, 오래된 snapshot, 바뀐 소유자, 변경된 출처, 충돌하는 재호출과 같은 원 영수증의 반복 정정은 변경 없이 실패한다. 정확한 재호출은 같은 상태와 실측 관찰을 다시 검증한다. 원 단위·목표 의미, 원 영수증, custody, 단계, 실패, 게이트, 리뷰는 그대로다. 정정은 소유권·기동·이전·전달·종료 권한을 만들지 않는다. 철회나 의미 롤백은 별도 operation이다.

완전히 완료된 목표의 Closed 최종 단위는 원 accepted 대상, 목표 완료 proof와 불변 결과 파일을 사용한다. 명시적 completionProof는 별도의 신뢰된 읽기 전용 검증기로 당시 native 신원·처분·수용 소스를 결속한다. 프로세스 생존 여부나 현재 checkout은 이력 증거를 대신하지 않는다. 두 검증기는 같은 잠금 아래 실행되고 미해결 효과는 감사를 막는다.

provenance ref는 절대 경로의 불변 파일이다. 그 바이트는 문맥 검증 전후의 출처 fence와 source digest에 포함된다. 의미상 userInputRef는 원 사람 지시를 문맥과 함께 가리킨다. 제어면이 바이트를 직접 재확인할 수 없는 불투명 locator는 거부한다.

마지막 불변 출처 fence는 마지막 비동기 대상·native 관찰 뒤, append 또는 중복 반환 직전에 실행한다. 현재 대상은 마지막 native 관찰 뒤 Git 대상을 다시 비교한 다음 그 fence를 통과해야 한다. 관찰을 기다리는 동안의 변경도 거부하기 위해서다.

## 제외한 방법

원 행의 수정·삭제, adoption replay·rebind, 같은 값의 goal amend, 다른 scope·policy 정정 명령은 adoption·목표 변경 승인 출처를 정정하는 방법이 아니다.
