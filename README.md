# ipe-study-progress-system

정보처리기사 학습 진도 및 Concept Atlas 시스템.

저장소 v2는 브라우저 Persistence Kernel, 정규화된 Supabase 테이블, 낙관적 revision 충돌 방지, append-only 복구 이력을 사용한다. 최초 전환 절차는 [MIGRATION-V2.md](MIGRATION-V2.md)를 따른다.

## 통합 저장·백업

- App·Atlas·Bridge의 기준 원본은 IndexedDB의 단일 통합 스냅샷이다. 기존 localStorage 키는 UI 호환과 비정상 종료 복구용 mirror로 유지한다.
- 실제 데이터 변경은 스냅샷과 영속 outbox를 먼저 기록한 뒤 Supabase revision으로 자동 커밋한다.
- 재시도는 IndexedDB에 기록된 같은 `operationId`를 사용하므로 서버 성공 직후 응답이 유실되어도 중복 revision을 만들지 않는다.
- 상단 `지금 저장`은 모든 Atlas iframe의 저장 요청을 기다린 뒤 부모가 승인한 최신 세대를 저장하고 서버 revision/hash를 재검증한다.
- 상단에는 로컬 저장 상태와 서버 저장 상태가 독립적으로 표시된다.
- 파일 백업은 `ipe-learning-os-backup` schema v3 형식이며 Supabase 연결 정보는 제외한다.
- 백업/서버 revision 복구는 로컬 확인 단계까지만 자동으로 수행하며, 서버 반영은 `지금 저장`으로 확정한다.
- 다중 탭 서버 writer는 Web Lock으로 직렬화하며, 미지원 브라우저에서는 만료·갱신되는 localStorage lease를 사용한다.
- IndexedDB 기록 전 종료된 legacy write와 IndexedDB 기록 후 mirror 전파 전 종료된 write를 각각 dirty marker와 read-back reconciliation으로 복구한다.

구현된 데이터 흐름은 [TO-BE persistence architecture](docs/architecture/to-be/README.md)에 정리되어 있다.

기존 Supabase 프로젝트는 최신 [supabase-normalized-v2.sql](supabase-normalized-v2.sql)을 다시 실행해야 과거 revision 복구 RPC를 사용할 수 있다. SQL은 `create if not exists`와 `create or replace function`으로 구성되어 기존 revision 데이터를 삭제하지 않는다.
