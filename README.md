# ipe-study-progress-system
정처기 학습을 위한 체계적인 진도관리 시스템

## 대용량 Atlas 런타임

- `atlas-performance.js`: 개념/프레임/상하위/Bridge 관계 O(1) 인덱스, 가상 피드·탐색기, 스키마 검증, IndexedDB 비동기 미러
- `atlas-map.js`: 상하위·연관·키워드를 그리는 전체화면 Canvas 무한 지도
- 기존 `localStorage`와 Supabase AES-GCM 전체 스냅샷은 호환성을 위해 계속 원본으로 유지한다. IndexedDB 마이그레이션은 복제본 검증이 성공한 경우에만 적용되며 실패하면 기존 저장소로 자동 복귀한다.

5,000개 개념/키워드와 관계 속성을 포함한 성능 회귀 테스트:

```bash
node tests/performance-benchmark.mjs
```
