import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql=fs.readFileSync(new URL('../supabase-normalized-v2.sql',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

assert.match(sql,/create table if not exists public\.ipe_concepts/,'concepts must be normalized');
assert.match(sql,/create table if not exists public\.ipe_concept_lines/,'concept lines must be normalized');
assert.match(sql,/create table if not exists public\.ipe_concept_relations/,'concept relationships must be normalized');
assert.match(sql,/create table if not exists public\.ipe_study_concept_links/,'study links must be normalized');
assert.match(sql,/create table if not exists public\.ipe_orphan_study_links/,'dangling legacy links must be preserved outside active relations');
assert.match(sql,/member_kind text not null/,'frame members must distinguish concepts from objects');
assert.match(sql,/references public\.ipe_concepts\(sync_id, concept_id\) on delete cascade/,'dependent entities require concept foreign keys');
assert.match(sql,/v_workspace\.head_revision <> p_expected_revision/,'stale devices must be rejected');
assert.match(sql,/revision conflict:/,'conflicts need an explicit error');
assert.match(sql,/unique \(sync_id, operation_id\)/,'commit retries must be idempotent');
assert.match(sql,/commit rejected: %s study links reference missing concepts/,'dangling study links must block commits');
assert.match(sql,/create table if not exists public\.ipe_revisions/,'append-only revision history is required');
assert.doesNotMatch(sql,/delete from public\.ipe_revisions/,'revision history must not be overwritten');

assert.match(client,/payloadHash===m\.lastPayloadHash/,'unchanged data must not create a commit');
assert.match(client,/p_expected_revision:Number\(m\.serverRevision\)/,'client commits must use optimistic concurrency');
assert.match(client,/다른 디바이스가 먼저 저장함/,'client must surface multi-device conflicts');
assert.match(client,/저장되지 않은 로컬 변경이 있어 원격 적용을 차단함/,'pull must not overwrite dirty local data');
assert.match(client,/PREPULL_KEY/,'pull must preserve a local pre-apply backup');
assert.match(client,/delete settings\.supabaseSync/,'Supabase credentials must never enter normalized app state');
assert.match(client,/integrated&&parsedFile\.bridge\?parsedFile\.bridge:current\.bridge/,'integrated backups must restore Bridge instead of relying on the current browser');
assert.match(client,/integrated&&parsedFile\.app\?parsedFile\.app:current\.app/,'integrated backups must restore App progress and notes');
assert.match(client,/본문 없는 학습 연결/,'client must detect dangling bridge references');
assert.match(client,/global\.v14TryStartupPull=function\(\)\{\}/,'destructive startup pull must be disabled');
assert.match(html,/normalized-sync\.js/,'normalized sync runtime must be loaded');
assert.match(html,/IpeNormalizedSync\?\.install\(\)/,'normalized sync runtime must be installed before initial render');

console.log('normalized storage regression: ok');
