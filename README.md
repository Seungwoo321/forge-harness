# forge-harness

**개발 작업 단위를 항상 같은 절차와 같은 품질 기준으로 처리한다.** 범위 확정 → 구현 → 결정적 게이트 → 수용 → 전달 → 인계를 하나의 상태 기계로 돌리고, 상태·증거·부작용은 스크립트만 쓴다.
Run every unit of development work through the same lifecycle — scope, implement, deterministic gates, acceptance, delivery, handoff — with state, evidence and side effects owned by scripts and judgment owned by per-stage skills.

- 흐름·상태·재시도·증거 해시는 제어면 스크립트가, 생성·판단·진단은 스킬이 소유한다.
- 수용 근거는 생산자의 선언이 아니라 게이트 증거와 수용 기준 커버리지다. 리뷰는 정책이 요구할 때 더한다.
- 실패는 제품·하네스·환경·사용자 영역으로 분류하고 원인 서명으로 상한을 센다. 복구는 되돌리기가 아니라 진단 후 앞으로 고치기다.
- 권한·리뷰·재시도는 작업 종류가 아니라 **최종 목표 유형**(단건 태스크 / 출시 전 제품 / 출시된 제품)의 정책이 정한다. 정책이 없으면 대화형 스킬이 먼저 묻는다.

최종 모습은 [`docs/spec.md`](docs/spec.md), 결정 배경은 [`docs/adr/`](docs/adr/) 에 있다. `docs/spec.md` §12 의 적합성 목록이 구현 갭 판정의 기준이다.

## 설치

Claude Code 와 Codex 둘 다 지원한다. 같은 `skills/` 를 공유한다.

```bash
# Claude Code
/plugin marketplace add Seungwoo321/forge-harness
/plugin install forge-harness@forge-harness

# Codex
codex plugin marketplace add Seungwoo321/forge-harness
codex plugin add forge-harness@forge-harness
```

## 개발

```bash
pnpm install
pnpm test
```

로컬 개발 중에는 `/plugin marketplace add ./` 로 이 폴더를 마켓플레이스로 추가해 설치한다.
