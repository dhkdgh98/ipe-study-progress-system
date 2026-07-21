# 정규화 저장소 v2 전환

## 변경 목적

기존 저장 방식은 App, Atlas, Bridge를 서로 다른 시점에 저장한 뒤 `learning_os_snapshots`의 단일 행을 덮어썼다. v2는 다음을 보장한다.

- 개념, 개념 노트, 관계, 학습 연결, 프레임을 정규화된 테이블에 분리한다.
- 한 커밋의 관련 변경은 PostgreSQL 트랜잭션 하나로 적용한다.
- 클라이언트가 읽은 `expected_revision`과 서버 head가 다르면 커밋을 거부한다.
- 모든 성공한 커밋은 `ipe_revisions`에 append-only로 남긴다.
- Bridge가 존재하지 않는 개념을 가리키면 커밋을 거부한다.
- 접속 시 자동 원격 덮어쓰기를 하지 않는다.
- 실제 데이터 해시가 바뀌지 않았으면 새 revision을 만들지 않는다.

## 최초 전환 순서

1. 현재 브라우저와 외부 파일에 백업을 유지한다.
2. Supabase SQL Editor에서 `supabase-normalized-v2.sql` 전체를 실행한다.
3. 새 버전의 `index.html`, `normalized-sync.js`, `supabase-normalized-v2.sql`을 함께 배포한다.
4. 앱의 운영 설정에서 `정규화 저장소 v2` 패널을 연다.
5. `Atlas 백업 가져오기`로 v17 통합 백업을 선택한다. 통합 백업이면 App·Bridge·Atlas를 함께 적용하고, Atlas 단독 백업이면 현재 App·Bridge를 유지한다.
6. 본문이 없는 Bridge 연결이 발견되면 고아 연결 보관소로 분리하는 작업을 확인한다.
7. `무결성 점검`이 정상인지 확인한다.
8. `현재 데이터 커밋`을 눌러 revision 1을 만든다.
9. `revision 이력`에서 개념 수와 연결 수를 확인한다.

기존 `learning_os_snapshots` 테이블은 자동으로 삭제하지 않는다. v2가 정상 동작하고 별도 백업을 확보할 때까지 레거시 복구 자료로 보존한다.

## 현재 백업에 대한 사전검사

제공된 `concept-atlas-v3.json`에는 개념 158개, 프레임 15개, 객체 12개, 키워드 302개가 있다.

복구된 기존 Bridge 179개와 결합하면 본문이 없는 연결이 총 47개다. v2 가져오기는 이를 삭제하지 않고 `bridge.orphanedLinks`와 `ipe_orphan_study_links`에 보존한다. 정상 활성 연결은 132개가 된다.

## 다중 기기 규칙

각 브라우저는 고유 `deviceId`와 마지막으로 확인한 `serverRevision`을 가진다.

예를 들어 서버가 revision 8인데 맥북이 revision 7을 기준으로 커밋하면 서버는 저장을 거부한다. 맥북 데이터가 윈도우의 revision 8을 덮어쓸 수 없다. 로컬 데이터는 그대로 유지되며 사용자가 원격 revision을 확인해야 한다.

현재 v2의 우선 목표는 무손실과 충돌 차단이다. 같은 base revision에서 발생한 서로 다른 카드 변경을 자동 병합하는 mutation API는 다음 단계로 추가할 수 있지만, 자동 병합이 없어도 오래된 전체 상태가 최신 상태를 삭제하는 동작은 차단된다.

## 운영 원칙

- 충돌 발생 시 어느 한쪽을 즉시 덮어쓰지 않는다.
- 원격 적용 전 현재 로컬 상태를 `ipe-normalized-prepull-v2`에 보존한다.
- Atlas 백업 적용 전 상태는 `ipe-normalized-preimport-v2`에 보존한다.
- `ipe_revisions` 행을 update 또는 delete하지 않는다.
- revision 정리 정책을 만들기 전에는 서버 이력을 수동 삭제하지 않는다.
- 기존 레거시 테이블은 v2 검증 완료 전까지 삭제하지 않는다.
