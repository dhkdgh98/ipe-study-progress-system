(function(global){
  'use strict';

  const META_KEY='ipe-normalized-sync-v2';
  const PREPULL_KEY='ipe-normalized-prepull-v2';
  const PENDING_IMPORT_KEY='ipe-normalized-pending-import-v2';
  const enc=new TextEncoder();
  let installed=false,dirty=false,commitTimer=0,inFlight=null,importInProgress=false;

  function parse(raw,fallback=null){try{return raw?JSON.parse(raw):fallback}catch{return fallback}}
  function uuid(){return crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)})}
  function meta(){
    const value={version:2,deviceId:uuid(),serverRevision:0,lastPayloadHash:'',lastCommitAt:'',dirty:false,...parse(localStorage.getItem(META_KEY),{})};
    localStorage.setItem(META_KEY,JSON.stringify(value));return value;
  }
  function setMeta(patch){const value={...meta(),...patch};localStorage.setItem(META_KEY,JSON.stringify(value));return value}
  function cfg(){return typeof global.cloudCfg==='function'?global.cloudCfg():null}
  function enabled(){const c=cfg();return !!(c?.url&&c?.anonKey&&c?.syncKey)}
  async function sha256(value){const digest=await crypto.subtle.digest('SHA-256',enc.encode(value));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}
  async function ids(secret){return {syncId:await sha256('ipe-learning-os:id:'+secret),writeHash:await sha256('ipe-learning-os:write:'+secret)}}
  function stable(value){
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  function appData(value){
    const settings={...(value?.settings||{})};delete settings.supabaseSync;
    return {version:value?.version||4,progress:value?.progress||{},notes:value?.notes||{},settings};
  }
  function localPayload(){
    const pending=parse(localStorage.getItem(PENDING_IMPORT_KEY),null);
    if(pending?.atlas&&pending?.bridge&&pending?.app)return {version:2,app:appData(pending.app),atlas:pending.atlas,bridge:pending.bridge};
    const atlas=typeof global.v17StorageGet==='function'?global.v17StorageGet(global.ATLAS_STORAGE):parse(localStorage.getItem('concept-atlas-v3-feed'),null);
    const bridge=typeof global.bridge==='function'?global.bridge():parse(localStorage.getItem('ipe-atlas-bridge-v1'),{});
    const currentApp=typeof global.__ipeGetAppState==='function'?global.__ipeGetAppState():{};
    return {version:2,app:appData(currentApp),atlas:atlas||{concepts:[],frames:[],keywords:[],objects:[]},bridge:bridge||{links:[],catalog:[]}};
  }
  function validate(payload){
    const errors=[],warnings=[];
    const concepts=Array.isArray(payload?.atlas?.concepts)?payload.atlas.concepts:[];
    const objects=Array.isArray(payload?.atlas?.objects)?payload.atlas.objects:[];
    const links=Array.isArray(payload?.bridge?.links)?payload.bridge.links:[];
    const ids=new Set();
    for(const concept of concepts){if(!concept?.id)errors.push('ID가 없는 개념이 있음');else if(ids.has(concept.id))errors.push('중복 개념 ID: '+concept.id);else ids.add(concept.id)}
    const dangling=links.filter(link=>!ids.has(link?.conceptId));
    if(dangling.length)errors.push(`본문 없는 학습 연결 ${dangling.length}개`);
    for(const concept of concepts){
      for(const parent of concept.parents||[])if(!ids.has(parent))errors.push(`${concept.id}: 존재하지 않는 상위 개념 ${parent}`);
      for(const related of concept.related||[])if(!ids.has(related))errors.push(`${concept.id}: 존재하지 않는 연관 개념 ${related}`);
    }
    const entityIds=new Set([...ids,...objects.map(object=>object?.id).filter(Boolean)]);
    for(const frame of payload?.atlas?.frames||[])for(const member of frame.members||[])if(!entityIds.has(member))errors.push(`${frame.id}: 존재하지 않는 프레임 멤버 ${member}`);
    if(!concepts.length)warnings.push('Atlas 개념이 0개임');
    return {ok:!errors.length,errors:[...new Set(errors)],warnings,dangling,conceptCount:concepts.length,linkCount:links.length};
  }
  async function rpc(name,body){
    const c=cfg();if(!c?.url||!c?.anonKey)throw new Error('Supabase 연결 정보가 없음');
    const response=await fetch(`${c.url.replace(/\/$/,'')}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:c.anonKey,Authorization:`Bearer ${c.anonKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const text=await response.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}
    if(!response.ok){const message=typeof data==='string'?data:(data?.message||`HTTP ${response.status}`);const error=new Error(message);error.status=response.status;error.detail=data?.details||data?.detail||'';throw error}
    return data;
  }
  async function commit(reason='data-change'){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      if(!enabled())throw new Error('정규화 원격 저장 연결 정보가 없음');
      const payload=localPayload(),audit=validate(payload);
      if(!audit.ok)throw new Error('원격 커밋 차단: '+audit.errors.join(' / '));
      const payloadHash=await sha256(stable(payload));
      const m=meta();
      if(payloadHash===m.lastPayloadHash){dirty=false;setMeta({dirty:false});return {skipped:true,revision:m.serverRevision,audit}}
      const c=cfg(),identity=await ids(c.syncKey),operationId=uuid();
      global.cloudSetStatus?.(`revision ${m.serverRevision} → 원격 커밋 중`);
      let result;
      try{
        result=await rpc('ipe_commit_state',{p_sync_id:identity.syncId,p_write_hash:identity.writeHash,p_expected_revision:Number(m.serverRevision)||0,p_operation_id:operationId,p_device_id:m.deviceId,p_payload_hash:payloadHash,p_app:payload.app,p_atlas:payload.atlas,p_bridge:payload.bridge});
      }catch(error){
        if(/revision conflict|40001/i.test(error.message+' '+error.detail)){
          setMeta({dirty:true,lastConflictAt:new Date().toISOString(),lastConflict:error.message});
          global.cloudSetStatus?.('원격 충돌 감지 · 자동 덮어쓰기 중단');
          throw new Error('다른 디바이스가 먼저 저장함. 로컬 데이터는 유지됐고 원격 덮어쓰기는 차단됨.');
        }
        throw error;
      }
      const row=Array.isArray(result)?result[0]:result;
      dirty=false;setMeta({serverRevision:Number(row?.revision)||m.serverRevision,lastPayloadHash:payloadHash,lastCommitAt:row?.committed_at||new Date().toISOString(),dirty:false,lastReason:reason,lastConflict:''});
      global.cloudSetStatus?.(`원격 revision ${row?.revision} 저장·무결성 검증 완료`,row?.committed_at||'');
      return {row,audit,payloadHash};
    })();
    try{return await inFlight}finally{inFlight=null}
  }
  function schedule(reason='data-change',delay=450){
    dirty=true;setMeta({dirty:true,lastDirtyAt:new Date().toISOString(),lastReason:reason});
    clearTimeout(commitTimer);
    const guard=global.__ipeNormalizedImportGuard;
    if(importInProgress||(guard&&Date.now()<guard.until))return;
    const c=cfg();
    if(c?.auto&&enabled())commitTimer=setTimeout(()=>commit(reason).catch(error=>global.cloudSetStatus?.('원격 저장 보류: '+error.message)),delay);
  }
  async function head(){
    const c=cfg();if(!enabled())throw new Error('Supabase 연결 정보가 없음');
    const identity=await ids(c.syncKey);
    try{const rows=await rpc('ipe_load_head',{p_sync_id:identity.syncId,p_write_hash:identity.writeHash});return Array.isArray(rows)?rows[0]||null:rows}catch(error){if(/invalid sync key/i.test(error.message))return null;throw error}
  }
  async function pull(){
    const remote=await head();if(!remote)throw new Error('정규화 저장소에 원격 revision이 없음');
    const localApp=typeof global.__ipeGetAppState==='function'?global.__ipeGetAppState():{};
    const payload={version:2,app:{...remote.app_state,settings:{...(remote.app_state?.settings||{}),supabaseSync:localApp?.settings?.supabaseSync}},atlas:remote.atlas_state,bridge:remote.bridge_state};
    const audit=validate(payload);if(!audit.ok)throw new Error('원격 데이터 무결성 오류: '+audit.errors.join(' / '));
    const current=localPayload(),currentHash=await sha256(stable(current));
    if(dirty||meta().dirty)throw new Error('저장되지 않은 로컬 변경이 있어 원격 적용을 차단함');
    if(!confirm(`원격 revision ${remote.revision}을 적용할까?\n현재 로컬 데이터는 적용 전에 보존된다.`))return {cancelled:true};
    try{localStorage.setItem(PREPULL_KEY,JSON.stringify({savedAt:new Date().toISOString(),payload:current}))}catch{throw new Error('적용 전 로컬 백업을 만들 수 없어 원격 적용을 차단함')}
    if(typeof global.applySnapshotPayload!=='function')throw new Error('가져오기 함수가 준비되지 않음');
    global.applySnapshotPayload(payload);
    setMeta({serverRevision:Number(remote.revision)||0,lastPayloadHash:remote.payload_hash||await sha256(stable(payload)),lastPullAt:new Date().toISOString(),prePullHash:currentHash,dirty:false});dirty=false;
    global.cloudSetStatus?.(`원격 revision ${remote.revision} 적용 완료`,remote.created_at||'');
    return {remote,audit};
  }
  async function history(limit=30){
    const c=cfg(),identity=await ids(c.syncKey);
    return rpc('ipe_list_revisions',{p_sync_id:identity.syncId,p_write_hash:identity.writeHash,p_limit:limit});
  }
  async function importAtlasFile(file){
    if(typeof global.cloudReadInputs==='function')global.cloudReadInputs();
    const parsedFile=parse(await file.text(),null);
    const atlas=parsedFile?.atlas||parsedFile;
    if(!atlas||!Array.isArray(atlas.concepts)||!Array.isArray(atlas.frames))throw new Error('Atlas 백업 형식이 아님');
    const current=localPayload();
    const integrated=!!parsedFile?.atlas;
    const backupApp=integrated&&parsedFile.app?parsedFile.app:current.app;
    const backupBridge=integrated&&parsedFile.bridge?parsedFile.bridge:current.bridge;
    const candidate={version:2,app:appData(backupApp),atlas,bridge:backupBridge};
    let audit=validate(candidate),bridge=candidate.bridge;
    if(audit.dangling.length){
      const byItem=audit.dangling.reduce((out,link)=>{out[link.itemId]=(out[link.itemId]||0)+1;return out},{});
      const detail=Object.entries(byItem).map(([itemId,count])=>`${itemId}: ${count}개`).join(', ');
      if(!confirm(`백업 Atlas에는 본문이 없지만 Bridge에만 남은 연결이 ${audit.dangling.length}개 있다.\n${detail}\n\n정상 연결에서 분리해 고아 연결 보관소에 보존하고 백업을 적용할까?`))throw new Error('고아 연결 보관을 취소해 백업 적용을 중단함');
      const danglingKeys=new Set(audit.dangling.map(link=>`${link.itemId}\u0000${link.conceptId}`));
      const archived=audit.dangling.map(link=>({...link,reason:'missing_concept_body',archivedAt:new Date().toISOString()}));
      bridge={...bridge,orphanedLinks:[...(bridge.orphanedLinks||[]),...archived],links:(bridge.links||[]).filter(link=>!danglingKeys.has(`${link.itemId}\u0000${link.conceptId}`))};
      audit=validate({...candidate,bridge});
    }
    if(!audit.ok)throw new Error('백업 적용 차단: '+audit.errors.join(' / '));
    try{localStorage.setItem('ipe-normalized-preimport-v2',JSON.stringify({savedAt:new Date().toISOString(),payload:current}))}catch{throw new Error('적용 전 로컬 백업을 만들 수 없어 가져오기를 차단함')}
    const currentApp=typeof global.__ipeGetAppState==='function'?global.__ipeGetAppState():{};
    const currentSync={...(currentApp?.settings?.supabaseSync||cfg()||{})};
    const appliedApp={...backupApp,settings:{...(backupApp?.settings||{}),supabaseSync:currentSync}};
    localStorage.setItem(PENDING_IMPORT_KEY,JSON.stringify({savedAt:new Date().toISOString(),app:appliedApp,atlas,bridge}));
    global.__ipeNormalizedImportGuard={atlas,bridge,until:Date.now()+15000};
    importInProgress=true;clearTimeout(commitTimer);
    try{
      if(typeof global.applySnapshotPayload==='function')global.applySnapshotPayload({version:2,app:appliedApp,atlas,bridge});
      else{
        localStorage.setItem('concept-atlas-v3-feed',JSON.stringify(atlas));
        localStorage.setItem('ipe-atlas-bridge-v1',JSON.stringify(bridge));
        if(typeof global.invalidateBridgeCache==='function')global.invalidateBridgeCache();
        for(const id of ['studyAtlas','globalAtlas']){const frame=document.getElementById(id);try{frame?.contentWindow?.postMessage({type:'ipe-atlas-import-state',state:atlas},'*')}catch{}}
      }
      await new Promise(resolve=>setTimeout(resolve,400));
      localStorage.setItem('concept-atlas-v3-feed',JSON.stringify(atlas));
      localStorage.setItem('ipe-atlas-bridge-v1',JSON.stringify(bridge));
      if(typeof global.invalidateBridgeCache==='function')global.invalidateBridgeCache();
      const appliedAudit=validate(localPayload());
      if(!appliedAudit.ok||appliedAudit.conceptCount!==atlas.concepts.length)throw new Error('가져온 Atlas가 iframe 반영 중 덮어써져 적용을 중단함');
      dirty=true;setMeta({dirty:true,lastDirtyAt:new Date().toISOString(),lastReason:'atlas-backup-import',lastConflict:''});
    }finally{importInProgress=false}
    return {audit,integrated,removedDangling:(candidate.bridge.links||[]).length-(bridge.links||[]).length};
  }
  function panel(){const m=meta();return `<section class="panel"><div class="panel-head"><div><div class="panel-title">정규화 저장소 v2</div><div class="panel-note">개념·노트·관계·학습 연결 분리 저장 · revision 충돌 차단 · append-only 복구 이력</div></div><span class="chip">revision ${Number(m.serverRevision)||0}</span></div><div class="panel-body"><div class="notice">접속 시 자동 덮어쓰기는 비활성화됨. 실제 데이터 해시가 달라질 때만 커밋하며, 다른 기기가 먼저 저장했으면 현재 로컬을 유지하고 충돌로 중단한다.</div><div class="cloud-actions" style="margin-top:12px"><button class="primary" data-v2-action="commit">현재 데이터 커밋</button><button data-v2-action="pull">원격 revision 확인·적용</button><button data-v2-action="history">revision 이력</button><button data-v2-action="copy-sql">v2 SQL 복사</button><button data-v2-action="audit">무결성 점검</button><button data-v2-action="import-atlas">Atlas 백업 가져오기</button><input id="v2AtlasBackupInput" type="file" accept="application/json,.json" hidden></div><div class="cloud-status" id="v2SyncStatus" style="margin-top:12px">${m.dirty?'로컬 변경 있음 · 원격 커밋 대기':'로컬 변경 없음'}${m.lastCommitAt?`<br>마지막 커밋: ${m.lastCommitAt}`:''}${m.lastConflict?`<br>충돌: ${m.lastConflict}`:''}</div></div></section>`}
  function install(){
    if(installed)return;installed=true;meta();
    const currentCfg=cfg();if(currentCfg)currentCfg.autoPull=false;
    global.v14TryStartupPull=function(){};
    global.cloudUploadNow=()=>commit('manual-or-auto');
    global.cloudDownloadNow=()=>pull();
    global.exportData=function(){
      const payload=localPayload(),blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),anchor=document.createElement('a');
      anchor.href=URL.createObjectURL(blob);anchor.download=`IPE_LearningOS_revision_${meta().serverRevision}_${new Date().toISOString().slice(0,10)}.json`;anchor.click();URL.revokeObjectURL(anchor.href);
      global.showToast?.('현재 부모 저장소 기준 통합 백업을 내보냈어.');
    };
    const baseSettings=global.renderSettings;
    global.renderSettings=function(){return baseSettings()+panel()};
    const baseSave=global.save;
    global.save=function(message){const result=baseSave(message);schedule('app-data-change',700);return result};
    window.addEventListener('message',event=>{if(event.data?.type!=='ipe-atlas-saved')return;const guard=global.__ipeNormalizedImportGuard;if(importInProgress||guard)return;schedule('atlas-commit',350)},false);
    document.addEventListener('click',async event=>{
      const button=event.target.closest('[data-v2-action]');if(!button)return;
      event.preventDefault();event.stopImmediatePropagation();
      const status=document.getElementById('v2SyncStatus');
      try{
        if(button.dataset.v2Action==='commit'){const result=await commit('manual');if(status)status.textContent=result.skipped?'변경 없음 · 커밋 생략':`revision ${result.row?.revision} 커밋 완료`}
        if(button.dataset.v2Action==='pull'){const result=await pull();if(status&&!result.cancelled)status.textContent=`revision ${result.remote.revision} 적용 완료`}
        if(button.dataset.v2Action==='history'){const rows=await history();if(status)status.innerHTML=(rows||[]).map(row=>`r${row.revision} · 개념 ${row.concept_count} · 연결 ${row.bridge_link_count} · ${row.device_id} · ${row.created_at}`).join('<br>')||'revision 없음'}
        if(button.dataset.v2Action==='copy-sql'){const sql=await (await fetch('supabase-normalized-v2.sql')).text();await navigator.clipboard.writeText(sql);if(status)status.textContent='v2 SQL 복사 완료'}
        if(button.dataset.v2Action==='audit'){const audit=validate(localPayload());if(status)status.textContent=audit.ok?`정상 · 개념 ${audit.conceptCount} · 연결 ${audit.linkCount}`:`오류 · ${audit.errors.join(' / ')}`}
        if(button.dataset.v2Action==='import-atlas'){
          if(typeof global.cloudReadInputs==='function')global.cloudReadInputs();
          const current=cfg();if(current){current.auto=false;current.autoPull=false}
          const app=typeof global.__ipeGetAppState==='function'?global.__ipeGetAppState():null;
          if(app)localStorage.setItem('ipe-learning-os-v4',JSON.stringify(app));
          global.render?.();
          setTimeout(()=>document.getElementById('v2AtlasBackupInput')?.click(),0);
        }
      }catch(error){if(status)status.textContent='실패 · '+error.message;global.showToast?.(error.message)}
    },true);
    document.addEventListener('change',async event=>{
      if(event.target.id!=='v2AtlasBackupInput'||!event.target.files?.[0])return;
      const status=document.getElementById('v2SyncStatus');
      try{const result=await importAtlasFile(event.target.files[0]);if(status)status.textContent=`${result.integrated?'통합':'Atlas'} 백업 적용 완료 · 개념 ${result.audit.conceptCount} · 고아 연결 ${result.removedDangling}개 별도 보존 · 원격 커밋 대기`}
      catch(error){if(status)status.textContent='백업 적용 실패 · '+error.message}
      finally{event.target.value=''}
    },true);
  }
  global.IpeNormalizedSync={install,commit,pull,history,schedule,validate,localPayload,importAtlasFile,meta};
})(window);
