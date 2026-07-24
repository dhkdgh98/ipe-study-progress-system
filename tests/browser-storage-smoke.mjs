import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const baseUrl=process.env.IPE_TEST_URL||'http://127.0.0.1:8765/';
const browser=await chromium.launch({headless:true,executablePath:process.env.IPE_CHROME_PATH});
const page=await browser.newPage({acceptDownloads:true});
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));

try{
  await page.goto(baseUrl,{waitUntil:'networkidle'});
  await page.evaluate(async()=>{
    const app=window.__ipeGetAppState();
    app.progress['001']={d0:'2026-07-24',reviews:{}};
    app.notes['001']='refresh-safe';
    window.save('browser-smoke');
    const atlas={
      concepts:[{
        id:'smoke-c1',
        title:'저장 테스트',
        domain:'test',
        definition:'새로고침 보존 확인',
        conceptRole:'core',
        importance:1,
        parents:[],
        related:[],
        notes:{definition:[{id:'line-1',text:'본문',keywords:[]}]},
      }],
      frames:[],
      objects:[],
      keywords:[],
    };
    const bridge={
      links:[{itemId:'001',conceptId:'smoke-c1',role:'핵심'}],
      orphanedLinks:[],
      catalog:[],
    };
    await window.IpeNormalizedSync.acceptAtlasSnapshot(atlas,bridge,{reason:'browser-smoke'});
  });
  const before=await page.evaluate(()=>({
    app:localStorage.getItem('ipe-learning-os-v4'),
    atlas:localStorage.getItem('concept-atlas-v3-feed'),
    bridge:localStorage.getItem('ipe-atlas-bridge-v1'),
  }));
  await page.reload({waitUntil:'networkidle'});
  const after=await page.evaluate(()=>({
    payload:window.IpeNormalizedSync.localPayload(),
    kernel:window.IpePersistenceKernel.diagnostics(),
    app:localStorage.getItem('ipe-learning-os-v4'),
    atlas:localStorage.getItem('concept-atlas-v3-feed'),
    bridge:localStorage.getItem('ipe-atlas-bridge-v1'),
    localStatus:document.getElementById('localSyncState')?.textContent,
    serverStatus:document.getElementById('serverSyncState')?.textContent,
  }));
  assert.equal(after.payload.app.progress['001'].d0,'2026-07-24');
  assert.equal(after.payload.atlas.concepts[0].id,'smoke-c1');
  assert.equal(after.payload.bridge.links[0].conceptId,'smoke-c1');
  assert.equal(after.kernel.snapshot.payloadHash.length,64,'IndexedDB kernel must retain a verified SHA-256 snapshot');
  assert.equal(after.app,before.app,'page reload must preserve App storage');
  assert.equal(after.atlas,before.atlas,'page reload must preserve Atlas storage');
  const beforeBridge=JSON.parse(before.bridge),afterBridge=JSON.parse(after.bridge);
  assert.deepEqual(afterBridge.links,beforeBridge.links,'page reload must preserve Bridge links');
  assert.deepEqual(afterBridge.orphanedLinks,beforeBridge.orphanedLinks,'page reload must preserve orphaned Bridge links');
  assert.ok(afterBridge.catalog.length>=beforeBridge.catalog.length,'derived Bridge catalog enrichment must not remove data');
  assert.match(after.localStatus,/로컬 · 저장됨/);
  assert.match(after.serverStatus,/서버 · 연결 안 됨/);
  const localOnlySave=await page.evaluate(()=>window.IpeNormalizedSync.flushNow('browser-test'));
  assert.equal(localOnlySave.localOnly,true,'manual save must still flush locally when Supabase is not configured');
  assert.match(await page.locator('#localSyncState').textContent(),/로컬 · 저장됨/);

  const downloadPromise=page.waitForEvent('download');
  await page.locator('[data-sync-action="backup"]').first().click();
  const download=await downloadPromise;
  const stream=await download.createReadStream();
  const chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  const backup=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(backup.format,'ipe-learning-os-backup');
  assert.equal(backup.schemaVersion,3);
  assert.equal(backup.counts.concepts,1);
  assert.equal(backup.counts.activeLinks,1);
  assert.equal(backup.data.app.settings.supabaseSync,undefined);

  await page.locator('[data-tab="settings"]').click();
  assert.equal(await page.getByText('Supabase 원격 동기화 · 로그인 없음').count(),0);
  assert.equal(await page.getByText('데이터 흐름 안정성 점검').count(),0);
  assert.equal(await page.getByText('저장·백업·복구').count(),1);
  assert.deepEqual(pageErrors,[]);
  console.log('browser storage smoke: ok');
}finally{
  await browser.close();
}
