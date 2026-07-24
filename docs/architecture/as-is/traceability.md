# Defect Traceability

분석 기준 커밋: `f15e1bd9802c98c43bc6f8c72e18572b9619db1f`

## 근본 문제 그룹

- **A — 단일 상태 권위 부재:** 논리적으로 같은 데이터에 여러 writer와 복사본이 존재하고 공통 revision이 없다.
- **B — 영속 동기화 프로토콜 부재:** workspace·operation·outbox·충돌·재시작 상태가 하나의 상태 머신으로 보존되지 않는다.
- **C — 공유 도메인 계약 부재:** App·Atlas·Bridge·backup·SQL이 동일한 schema와 invariant를 공유하지 않는다.
- **D — 개편 미완료와 장애 테스트 공백:** 레거시 저장기가 남고 정상 경로 중심 테스트가 구조적 결함을 막지 못한다.

## 결함 매핑

| ID | 확인된 결함 | 주 원인 | 관련 다이어그램 | 핵심 근거 | 검증 |
|---:|---|---|---|---|---|
| 1 | 두 Atlas 중 오래된 상태가 최신 상태를 덮을 수 있음 | A | 01, 02, 06 | `index.html:996-1021` | 브라우저 재현 `[R]` |
| 2 | iframe 없는 복구에서 pending이 고착되고 후속 편집을 가림 | A, B | 01, 04, 08 | `normalized-sync.js:70-105,396-425`, `index.html:1120-1134` | 브라우저 재현 `[R]` |
| 3 | syncKey/workspace 변경 후 이전 revision/hash 재사용 | B | 03, 04, 09 | `normalized-sync.js:22-44,616-625` | fake Supabase 재현 `[R]` |
| 4 | 응답 유실 재시도에서 operation ID가 변경됨 | B | 04, 07 | `normalized-sync.js:247-268` | fake Supabase 재현 `[R]` |
| 5 | 충돌 후 서버 수용/로컬 재기준화 경로가 없음 | B | 04, 09 | `normalized-sync.js:262-265,436-440,515-520` | 정적 대조 `[S]` |
| 6 | 최초 연결에서 기존 로컬 데이터 자동 업로드가 없음 | B | 04, 09 | `normalized-sync.js:488-503` | fake Supabase 재현 `[R]` |
| 7 | 개념 삭제가 Bridge 연결을 원자적으로 정리하지 않음 | A, C | 02, 03 | Atlas delete 경로와 `validate`/FK 대조 | 정적 대조 `[S][D]` |
| 8 | 클라이언트·백업 검증이 SQL 제약과 일치하지 않음 | C | 03, 11 | `normalized-sync.js:107-129,341-359`, SQL PK/FK/check | malformed payload 재현 `[R]` |
| 9 | PREIMPORT/PREPULL checkpoint를 복원하는 UI/operation 없음 | B | 04, 08, 12 | `normalized-sync.js:392,452` | 정적 대조 `[S]` |
| 10 | v13~v17 저장 함수·타이머·SQL이 코드에 남아 있음 | A, D | 02 | `index.html:593-594,833-915,992-1144` | 정적 대조 `[S]` |
| 11 | Bridge 다중 role 표현이 DB pair PK에서 하나로 축약됨 | C | 03 | SQL `ipe_study_concept_links` PK/upsert | 정적 대조 `[S][D]` |
| 12 | 종료 전 서버 미저장 경고와 영속 재개가 없음 | B | 01, 04, 10 | `index.html:402`, 메모리 retry timer | 정적 대조 `[S]` |

## 기존 모델의 추가 제약

| 제약 | 영향 | 근거 |
|---|---|---|
| App progress와 Bridge itemId가 코드의 정적 `ITEMS` ID를 참조 | item ID 변경 시 progress/link가 고아가 됨 | `index.html:107-109` `[S]` |
| `concept-atlas-v3-feed`의 배열 순서가 화면 순서 | set/map 또는 DB 재구축 시 순서 손실 가능 | Atlas state와 SQL `order_index` `[S][D]` |
| `ipe_concept_lines` PK가 workspace 전체 line ID | 서로 다른 concept의 같은 line ID도 충돌 | SQL `52-64` `[D]` |
| relation table은 self relation 금지, 배열 순서는 미보존 | JSON과 projection의 표현력 차이 | SQL `77-90` `[D]` |
| frame anchor는 concept 삭제 시 null, member entity는 다형 참조 | 삭제/복구 정책을 별도 정의해야 함 | SQL `114-140` `[D]` |
| 전체 projection을 commit마다 삭제 후 재삽입 | 데이터 성장 시 RPC 시간·쓰기량 증가 | SQL `320-418` `[D]` |
| revision은 전체 JSON append-only | 자동저장 빈도에 따라 저장량 지속 증가 | SQL `13-26,420-427` `[D]` |
| 현재 v2는 normalized JSON을 Supabase에 평문 저장 | 레거시 client-side 암호화와 보안 성질이 다름 | `index.html:598`, v2 SQL JSONB `[S][D]` |

## 다이어그램과 검증의 사용 원칙

1. 다이어그램의 관계는 위 표의 코드/SQL/파일/런타임 근거 중 하나 이상을 가져야 한다.
2. `[I]` 관계는 구현 전 추가 trace 또는 테스트로 승격해야 한다.
3. AS-IS와 TO-BE 요소를 같은 다이어그램에 섞지 않는다.
4. 구조 개편 후에는 같은 결함 ID로 회귀 테스트를 유지해 해결 여부를 추적한다.
