# IPE Learning OS AS-IS Architecture Dossier

## 기준과 목적

- 분석 커밋: `f15e1bd9802c98c43bc6f8c72e18572b9619db1f`
- 분석 시각: 2026-07-24, Asia/Seoul
- 범위: 브라우저 App, 두 Atlas iframe, Bridge, 로컬 저장, 백업·복구, Supabase v2, 레거시 v13~v17 저장 계층
- 목적: 현재 구조와 행위를 객관적으로 설명하고, 확인된 결함과 코드·SQL·실행 근거를 추적 가능하게 연결
- 제외: TO-BE 상세 설계와 구현 선택. 이 문서는 현재 상태만 기술한다.

## 근거 표기

| 표기 | 의미 |
|---|---|
| `[S]` | 정적 코드에서 직접 확인 |
| `[D]` | SQL schema/RPC에서 직접 확인 |
| `[F]` | 실제 백업 파일에서 확인 |
| `[R]` | 브라우저 또는 테스트 재현으로 확인 |
| `[I]` | 여러 근거를 조합한 분석적 추론 |

## 다이어그램 읽는 순서

1. 시스템 경계와 외부 의존성
2. 실제 배치와 데이터 복사본
3. 컴포넌트와 쓰기 권한
4. 도메인 데이터와 제약
5. 동기화 상태 머신
6. 정상 및 장애 시퀀스
7. 실제 백업 객체 상태
8. migration 활동과 중단 조건

## 다이어그램 목록

| 번호 | 다이어그램 | 질문 | 렌더링 |
|---|---|---|---|
| 00 | 시스템 컨텍스트 | 시스템 경계와 외부 저장소는 무엇인가 | [SVG](rendered/00-system-context.svg) |
| 01 | UML 배치 | 같은 데이터가 어느 실행 노드에 몇 벌 존재하는가 | [SVG](rendered/01-deployment.svg) |
| 02 | UML 컴포넌트 | 누가 데이터를 읽고 쓰며 어떤 함수가 덮어써지는가 | [SVG](rendered/02-component.svg) |
| 03 | UML 도메인 클래스 | 데이터 관계와 기존 제약은 무엇인가 | [SVG](rendered/03-domain-model.svg) |
| 04 | UML 상태 머신 | 저장·복구·충돌 상태가 어떻게 전이되는가 | [SVG](rendered/04-sync-state-machine.svg) |
| 05 | UML 시퀀스 | 정상 자동/수동 저장은 어떻게 동작하는가 | [SVG](rendered/05-sequence-normal-save.svg) |
| 06 | UML 시퀀스 | 두 Atlas 중 오래된 상태가 어떻게 선택되는가 | [SVG](rendered/06-sequence-dual-atlas.svg) |
| 07 | UML 시퀀스 | 서버 성공 후 응답 유실이 왜 충돌이 되는가 | [SVG](rendered/07-sequence-response-loss.svg) |
| 08 | UML 시퀀스 | iframe 없는 복구에서 pending이 왜 고착되는가 | [SVG](rendered/08-sequence-restore-no-frame.svg) |
| 09 | UML 시퀀스 | 최초 연결과 revision 충돌이 왜 정지하는가 | [SVG](rendered/09-sequence-bootstrap-conflict.svg) |
| 10 | UML 시퀀스 | 다중 탭과 종료·재실행에 어떤 공백이 있는가 | [SVG](rendered/10-sequence-multitab-close.svg) |
| 11 | UML 객체 | 제공된 revision 4 백업의 실제 모순은 무엇인가 | [SVG](rendered/11-object-backup-r4.svg) |
| 12 | UML 활동 | 구조 개편 migration의 안전 중단 조건은 무엇인가 | [SVG](rendered/12-migration-activity.svg) |

PlantUML 원본은 같은 디렉터리의 번호가 동일한 `.puml` 파일이다.

## 모델링 방식과 재생성

이 문서의 UML은 코드에서 관계를 기계적으로 추출한 결과가 아니라, 코드·SQL·백업·런타임 재현을 대조해 수동으로 모델링한 결과다. 이 코드베이스는 단일 HTML의 인라인 스크립트, iframe `postMessage`, 전역 함수 재할당, localStorage side effect가 결합되어 있어 정적 자동 생성만으로 실제 저장 권위와 실행 순서를 복원하기 어렵다.

자동화 도구는 보조 검증에 적합하다.

| 도구/관찰면 | 역할 |
|---|---|
| PlantUML | 검토 가능한 텍스트 원본을 SVG로 재현 |
| 정적 검색·호출 그래프 | 저장 key, writer, 전역 함수 교체 후보를 빠르게 열거 |
| 브라우저 trace | iframe 메시지, localStorage write, timer, 종료 순서를 확인 |
| Supabase schema/RPC 검사 | PK·FK·CAS·transaction·projection 제약 확인 |
| 장애 주입 테스트 | 응답 유실, offline, 충돌, no-frame restore, 다중 탭을 재현 |

PlantUML JAR와 Java가 있으면 PowerShell에서 다음처럼 전체 SVG를 재생성할 수 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\render.ps1 -PlantUmlJar C:\tools\plantuml-1.2026.6.jar
```

## 함께 읽을 문서

- [evidence-inventory.md](evidence-inventory.md): 저장소·메시지·RPC·레거시 override·백업 데이터 근거
- [traceability.md](traceability.md): 결함 → 근본 원인 → 다이어그램 → 코드/SQL → 검증 상태

## 핵심 해석

현재 시스템에는 App·Atlas·Bridge를 소유하는 단일 저장소가 없다. `normalized-sync.js`는 기존 저장기들을 대체하지 않고 런타임에 함수를 덮어쓰고 이벤트를 감시한 뒤, 저장 시점에 여러 복사본을 수집한다. 따라서 화면에 저장 버튼이 하나여도 내부에는 여러 writer와 여러 freshness 기준이 공존한다.

Supabase v2 RPC는 revision compare-and-swap과 operation ID 재생을 제공하지만, 클라이언트는 workspace별 메타와 영속 outbox를 유지하지 않는다. 서버 프로토콜이 제공하는 안전성을 클라이언트 생명주기 전체에서 보존하지 못한다.

전체 revision JSON과 정규화 projection도 동일한 표현력을 갖지 않는다. 현재 복구 원본은 revision JSON이며, 정규화 테이블을 원본으로 승격하려면 필드·순서·관계 cardinality를 먼저 보완해야 한다.

## 객관성 한계

- 정적 분석만으로 iframe, 함수 재할당, 문자열 코드 주입의 실제 실행 순서를 완전히 결정할 수 없다.
- 런타임 재현은 현재 브라우저와 테스트 harness의 관찰 결과이며 모든 기기·브라우저 조합을 대표하지 않는다.
- 제공된 revision 4 백업에는 Atlas 본문이 없어 전체 데이터의 유일한 기준 원본으로 사용할 수 없다.
- 다이어그램은 분석 커밋에 고정된다. 이후 코드 변경 시 근거 링크와 상태 전이를 다시 검증해야 한다.
