# Persistence Kernel Architecture

## 구현 목표

App·Atlas·Bridge의 저장 권위를 부모 브라우저의 Persistence Kernel 하나로 통합한다. IndexedDB working snapshot이 기준 원본이며 localStorage는 기존 UI 호환과 비정상 종료 write-ahead mirror로만 사용한다.

## 다이어그램

| 번호 | 관점 | 원본 | 렌더링 |
|---|---|---|---|
| 00 | 컴포넌트와 저장 권한 | [PlantUML](00-persistence-kernel-component.puml) | [SVG](rendered/00-persistence-kernel-component.svg) |
| 01 | 정상 저장과 응답 유실 재시도 | [PlantUML](01-save-and-retry-sequence.puml) | [SVG](rendered/01-save-and-retry-sequence.svg) |
| 02 | 시작 복구와 충돌 의사결정 | [PlantUML](02-recovery-and-conflict-activity.puml) | [SVG](rendered/02-recovery-and-conflict-activity.svg) |

## 구현 불변식

1. 서버 payload는 항상 App·Atlas·Bridge 통합 스냅샷 하나다.
2. 로컬 저장 완료는 IndexedDB transaction과 read-back hash 검증 뒤에만 표시한다.
3. 전송을 시작한 operation의 `operationId`, payload hash, expected revision은 재시도에서 바뀌지 않는다.
4. 한 workspace의 서버 writer는 Web Lock 또는 갱신 lease 하나다.
5. Atlas iframe 저장은 부모 generation ACK를 받아야 canonical이 된다.
6. backup restore와 remote pull은 기존 canonical checkpoint를 만든 뒤 새 canonical을 기록한다.
7. 서버 충돌은 자동 overwrite하지 않으며 사용자가 server 또는 local 중 하나를 명시적으로 선택한다.
8. legacy localStorage 키는 migration 검증 후에도 자동 삭제하지 않는다.

## 호환 계층의 수명

- `ipe-learning-os-v4`, `concept-atlas-v3-feed`, `ipe-atlas-bridge-v1`은 현재 UI boot와 비정상 종료 복구를 위해 유지한다.
- `ipe-normalized-pending-import-v2`는 구버전 복구 표식일 뿐 canonical read source가 아니다.
- v13~v17 원격 함수는 현재 runtime에서 비활성화되어 있지만 단일 HTML 안의 코드는 아직 남아 있다. 완전 삭제는 별도 정리 단계로 수행한다.

## 남은 구조 제약

- 서버 projection은 commit마다 전체 삭제·재삽입하므로 데이터가 커지면 RPC 시간이 증가한다.
- revision은 전체 JSON append-only라 자동저장 빈도에 비례해 저장량이 증가한다.
- 서로 다른 기기의 동시 변경은 자동 merge하지 않는다. CAS 충돌 후 사용자 선택으로 해결한다.
- Atlas iframe은 동일 사용자가 동시에 두 화면을 편집하는 mutation merge를 제공하지 않는다. 부모 generation이 stale snapshot overwrite는 차단하지만 stale 편집 자체는 최신 canonical로 되돌린다.
