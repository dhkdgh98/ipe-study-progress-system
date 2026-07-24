# ipe-study-progress-system

정보처리기사 학습 진도 및 Concept Atlas 시스템.

저장소 v2는 정규화된 Supabase 테이블, 낙관적 revision 충돌 방지, append-only 복구 이력을 사용한다. 최초 전환 절차는 [MIGRATION-V2.md](MIGRATION-V2.md)를 따른다.

## 통합 저장·백업

- App·Atlas·Bridge는 기존 localStorage 키를 유지하며 새로고침 시 자동 삭제하거나 원격 데이터로 덮어쓰지 않는다.
- 실제 데이터 변경은 로컬에 먼저 저장한 뒤 하나의 큐에서 Supabase revision으로 자동 커밋한다.
- 상단 `지금 저장`은 열린 Atlas iframe까지 flush하고 서버 revision/hash 재검증을 수행한다.
- 상단에는 로컬 저장 상태와 서버 저장 상태가 독립적으로 표시된다.
- 파일 백업은 `ipe-learning-os-backup` schema v3 형식이며 Supabase 연결 정보는 제외한다.
- 백업/서버 revision 복구는 로컬 확인 단계까지만 자동으로 수행하며, 서버 반영은 `지금 저장`으로 확정한다.

기존 Supabase 프로젝트는 최신 [supabase-normalized-v2.sql](supabase-normalized-v2.sql)을 다시 실행해야 과거 revision 복구 RPC를 사용할 수 있다. SQL은 `create if not exists`와 `create or replace function`으로 구성되어 기존 revision 데이터를 삭제하지 않는다.
