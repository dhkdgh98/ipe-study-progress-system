# Evidence Inventory

분석 기준 커밋: `f15e1bd9802c98c43bc6f8c72e18572b9619db1f`

## 1. 브라우저 저장 실체

| 저장 실체 | 내용 | 주요 writer | 근거 |
|---|---|---|---|
| `ipe-learning-os-v4` | App 전체 상태와 UI/설정 | `persistAppLocal`, snapshot 적용, sync collect/apply | `index.html:75,113-122,650,1047`, `normalized-sync.js:4,102,405` `[S]` |
| `concept-atlas-v3-feed` | Atlas 전체 상태 | Atlas iframe, parent flush, snapshot 적용, restore | `index.html:371,597,995,1016,1045,1131`, `normalized-sync.js:5,100,403` `[S]` |
| `ipe-atlas-bridge-v1` | active links, orphaned links, catalog | Bridge helper, iframe 응답, restore | `index.html:77,128-139,995,1017,1132`, `normalized-sync.js:6,101,404` `[S]` |
| `ipe-normalized-sync-v2` | device/revision/hash/dirty/generation/status | sync coordinator | `normalized-sync.js:7,22-51` `[S]` |
| `ipe-normalized-prepull-v2` | 원격 적용 전 checkpoint | `pull` | `normalized-sync.js:8,452` `[S]` |
| `ipe-normalized-preimport-v2` | 파일/서버 revision 복구 전 checkpoint | `applyCandidate` | `normalized-sync.js:9,392` `[S]` |
| `ipe-normalized-pending-import-v2` | iframe 적용 확인 전 복구 payload | `applyCandidate`, iframe ACK handler | `normalized-sync.js:10,70-77,396`, `index.html:1120-1134` `[S]` |

### 관찰

- App, Atlas, Bridge는 서로 다른 localStorage 키에 따로 기록된다. localStorage에는 다중 키 원자 트랜잭션이 없다. `[S][I]`
- 두 Atlas iframe은 각자 메모리 상태를 보유하고 parent localStorage와 동기화한다. `[S]`
- pending import는 존재하는 동안 실제 App/Atlas/Bridge보다 우선하여 payload 원본으로 사용된다. `normalized-sync.js:70-105` `[S]`

## 2. 런타임 복사본과 writer

| 논리 데이터 | 런타임 복사본 |
|---|---|
| App | parent `state`, `ipe-learning-os-v4`, backup/revision candidate |
| Atlas | study iframe `state`, global iframe `state`, parent `concept-atlas-v3-feed`, pending import, backup/revision candidate |
| Bridge | parent `bridgeCache`, iframe bridge snapshot, `ipe-atlas-bridge-v1`, pending import, backup/revision candidate |
| Sync meta | 메모리 timer/inFlight/import flags, `ipe-normalized-sync-v2` |

`v17ActiveAtlasFrames()`는 `studyAtlas`, `globalAtlas` 순으로 frame을 반환하고, `v17FlushAtlasFromFrames()`는 첫 유효 응답에서 중단한다. `index.html:996-1021` `[S]`

## 3. iframe 메시지

| 메시지 | 방향 | 목적 | 근거 |
|---|---|---|---|
| `ipe-atlas-context` | parent → iframe | 현재 학습 항목 context 전달 | `index.html:250,570,575` `[S]` |
| `ipe-atlas-saved` | iframe → parent | Atlas/Bridge snapshot과 저장 이벤트 전달 | `index.html:379,1118-1141`, `normalized-sync.js:654-662` `[S]` |
| `ipe-atlas-bridge-updated` | iframe → parent | Bridge 변경 알림 | `index.html:1144`, `normalized-sync.js:663` `[S]` |
| `ipe-atlas-export-request` | parent → iframe | 저장 직전 전체 상태 요청 | `index.html:997-1006` `[S]` |
| `ipe-atlas-export-response` | iframe → parent | 전체 상태 응답 | `index.html:1002` `[S]` |
| `ipe-atlas-import-state` | parent → iframe | 백업/원격 Atlas 적용 | `index.html:1050,1128` `[S]` |

메시지는 `'*'` origin으로 전달된다. parent는 일부 응답에서 `event.source`를 활성 frame과 대조하지만, 메시지 schema와 protocol version은 명시적으로 검증하지 않는다. `[S][I]`

## 4. 런타임 함수 교체

| 원래 기능 | 교체/래핑 위치 | 결과 |
|---|---|---|
| `save` | `normalized-sync.js:647-652` | 기존 로컬 저장 후 sync 변경 표시 |
| `cloudUploadNow` | `normalized-sync.js:640` | normalized `flushNow`로 연결 |
| `cloudDownloadNow` | `normalized-sync.js:641` | normalized `pull`로 연결 |
| `exportData` | `normalized-sync.js:642` | schema v3 backup 생성으로 연결 |
| `importData` | `normalized-sync.js:643` | normalized import로 연결 |
| `renderSettings` | `normalized-sync.js:645-646` | 레거시 설정 제거 후 신규 panel 추가 |
| `v14TryStartupPull` | `normalized-sync.js:639` | 빈 함수로 비활성화 |

`index.html`에는 이전 버전의 `exportData`, `importData`, `cloudUploadNow`, `cloudDownloadNow` 정의가 여러 번 남아 있다. `index.html:593-594,766-771,833-834,883-915,1063-1100` `[S]`

## 5. 동기화 클라이언트

| 단계 | 구현 | 근거 |
|---|---|---|
| collect | pending 우선, 아니면 iframe flush 후 App·Atlas·Bridge 수집 | `normalized-sync.js:70-105` |
| validate | concept/link/relation/frame member 일부 검사 | `normalized-sync.js:107-129` |
| hash | 정렬 직렬화 후 SHA-256 | `normalized-sync.js:55-60,228` |
| expected revision | 전역 meta의 `serverRevision` 사용 | `normalized-sync.js:22-44,253` |
| operation ID | 매 `commitOnce` 호출에서 새 UUID 생성 | `normalized-sync.js:247` |
| commit | `ipe_commit_state` RPC | `normalized-sync.js:250-260` |
| verify | `ipe_load_head`로 revision/hash 대조 | `normalized-sync.js:171-181,272-277` |
| retry | 메모리 timer로 `flushNow` 재호출 | `normalized-sync.js:203-210` |
| startup | 원격 없음이면 상태만 `empty/queued`로 설정 | `normalized-sync.js:488-520` |

## 6. Supabase v2

### RPC

- `ipe_commit_state`
- `ipe_load_head`
- `ipe_list_revisions`
- `ipe_load_revision`

### 핵심 테이블

- `ipe_workspaces`
- `ipe_revisions`
- `ipe_app_state`
- `ipe_concepts`
- `ipe_concept_lines`
- `ipe_line_keywords`
- `ipe_concept_relations`
- `ipe_study_concept_links`
- `ipe_orphan_study_links`
- `ipe_frames`
- `ipe_frame_members`
- `ipe_objects`
- `ipe_keywords`

### 서버 보장

- `(sync_id, revision)` PK와 `(sync_id, operation_id)` unique. `supabase-normalized-v2.sql:13-26` `[D]`
- workspace row lock 후 expected revision compare-and-swap. `supabase-normalized-v2.sql:298-318` `[D]`
- 같은 operation ID 재요청은 기존 revision을 반환. `supabase-normalized-v2.sql:304-311` `[D]`
- normalized current projection을 한 트랜잭션에서 전부 재구축. `supabase-normalized-v2.sql:320-418` `[D]`
- 전체 App·Atlas·Bridge JSON을 append-only revision에 저장. `supabase-normalized-v2.sql:420-427` `[D]`

### 표현력 차이

- revision JSON은 원본 payload 전체를 보존한다.
- projection은 `primaryParent`, 관계 배열 순서, 임의 확장 필드를 직접 표현하지 않는다.
- line keyword `order_index`는 현재 insert에서 항상 0이다. `supabase-normalized-v2.sql:353-356` `[D]`
- active Bridge PK는 `(sync_id,item_id,concept_id)`라 같은 pair의 여러 role을 하나로 합친다. `supabase-normalized-v2.sql:92-101,393-398` `[D]`

## 7. 제공된 revision 4 백업

파일: `C:\Users\dhkdg\Desktop\IPE_LearningOS_revision_4_2026-07-24.json`

| 항목 | 관찰값 |
|---|---:|
| 파일 크기 | 66,601 bytes |
| 최상위 형식 | `{version, app, atlas, bridge}` |
| payload version | 2 |
| envelope `format` | 없음 |
| `schemaVersion` | 없음 |
| `payloadHash` | 없음 |
| progress | 27 |
| notes | 0 |
| concepts/frames/objects/keywords | 0/0/0/0 |
| active/orphan links | 148/47 |
| catalog | 157 |
| active role | `핵심` 148 |
| orphan reason | `missing_concept_body` 47 |

`[F]` 이 파일은 Atlas 본문을 포함하지 않으며 내장 hash가 없어 단독 canonical source로 사용할 수 없다.

## 8. 런타임 재현 요약

| 재현 | 결과 |
|---|---|
| study/global Atlas가 서로 다른 상태인 채 flush | 첫 frame의 오래된 상태가 선택되고 localStorage가 역행 `[R]` |
| Atlas frame 없이 backup import 후 App 편집 | pending payload가 계속 우선되어 후속 편집이 collect에서 누락 `[R]` |
| syncKey 변경 후 commit | 이전 serverRevision/hash가 재사용 `[R]` |
| 서버 성공 후 첫 응답 유실 | 재시도 operation ID가 달라 idempotent replay 불가 `[R]` |
| 원격 head 없는 최초 연결 | 기존 로컬 데이터 자동 commit 없음 `[R]` |

기존 Node 회귀/벤치마크와 기본 브라우저 저장 smoke test는 통과했으나 위 장애 조합은 포함하지 않았다. `[R][I]`
