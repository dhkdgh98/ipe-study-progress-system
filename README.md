# ipe-study-progress-system

정보처리기사 학습 진도 및 Concept Atlas 시스템.

저장소 protocol 3은 브라우저 Persistence Kernel, 정규화된 Supabase 테이블, 낙관적 버전 충돌 방지, 이름 있는 복구 기록을 사용한다. 최초 전환 절차는 [MIGRATION-V2.md](MIGRATION-V2.md)를 따른다.

## 통합 저장·백업

- App·Atlas·Bridge의 기준 원본은 IndexedDB의 단일 통합 스냅샷이다. 기존 localStorage 키는 UI 호환과 비정상 종료 복구용 mirror로 유지한다.
- 실제 데이터 변경은 스냅샷과 영속 outbox를 먼저 기록한 뒤 Supabase의 현재 작업본으로 자동 저장한다.
- 재시도는 IndexedDB에 기록된 같은 `operationId`를 사용하므로 서버 성공 직후 응답이 유실되어도 작업 저장을 중복 적용하지 않는다.
- 상단 `저장`은 모든 Atlas iframe의 저장 요청을 기다린 뒤 부모가 승인한 최신 세대를 저장하고 서버 버전/hash를 재검증한다.
- 상단에는 로컬 저장 상태와 서버 저장 상태가 독립적으로 표시된다.
- 접속 직후에는 서버 head 확인이 끝날 때까지 업로드를 막는다. 로컬이 깨끗하고 서버가 더 최신이면 서버 데이터를 자동 적용하고, 로컬 변경이나 outbox가 있으면 충돌로 차단한다.
- 운영 설정의 `서버 최신 데이터 강제 적용`과 복구 기록의 `이 기록 강제 복구`는 서버 스냅샷을 먼저 검증한 뒤 이 origin의 localStorage와 Persistence Kernel 스냅샷·outbox·checkpoint를 전부 비우고 선택한 서버 복사본으로 교체한다. 연결 정보와 기기 이름만 다시 심는다.
- 이름 있는 복구 기록은 수동 저장, 변경 후 2분 유휴, 연속 작업 10분, 파괴적 덮어쓰기 직전에만 생성한다. 일반 자동저장·새로고침·서버 최신본 적용은 기록을 만들지 않는다.
- 파일 백업은 `ipe-learning-os-backup` schema v3 형식이며 Supabase 연결 정보는 제외한다.
- 백업/서버 복구 기록 적용은 로컬 확인 단계까지만 자동으로 수행하며, 서버 반영은 `저장`으로 확정한다.
- 다중 탭 서버 writer는 Web Lock으로 직렬화하며, 미지원 브라우저에서는 만료·갱신되는 localStorage lease를 사용한다.
- IndexedDB 기록 전 종료된 legacy write와 IndexedDB 기록 후 mirror 전파 전 종료된 write를 각각 dirty marker와 read-back reconciliation으로 복구한다.

구현된 데이터 흐름은 [TO-BE persistence architecture](docs/architecture/to-be/README.md)에 정리되어 있다.

기존 Supabase 프로젝트는 최신 [supabase-normalized-v2.sql](supabase-normalized-v2.sql)을 다시 실행해야 protocol 3 작업 저장과 이름 있는 복구 기록 RPC를 사용할 수 있다. SQL은 기존 `ipe_revisions` 데이터를 삭제하지 않으며, 현재 head를 새 작업 스냅샷으로 이관한다.
