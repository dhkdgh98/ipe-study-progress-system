(function(global){
  'use strict';

  const APP_KEY='ipe-learning-os-v4';
  const ATLAS_KEY='concept-atlas-v3-feed';
  const BRIDGE_KEY='ipe-atlas-bridge-v1';
  const META_KEY='ipe-normalized-sync-v2';
  const META_PREFIX='ipe-normalized-sync-v3:';
  const PREPULL_KEY='ipe-normalized-prepull-v2';
  const PREIMPORT_KEY='ipe-normalized-preimport-v2';
  const PENDING_IMPORT_KEY='ipe-normalized-pending-import-v2';
  const LEGACY_DIRTY_KEY='ipe-persistence-legacy-dirty-v1';
  const BACKUP_FORMAT='ipe-learning-os-backup';
  const CLIENT_PROTOCOL_VERSION=3;
  const HISTORY_IDLE_MS=2*60*1000;
  const HISTORY_CONTINUOUS_MS=10*60*1000;
  const enc=new TextEncoder();
  const kernel=global.IpePersistenceKernel||null;
  let installed=false;
  let commitTimer=0;
  let retryTimer=0;
  let historyIdleTimer=0;
  let historyContinuousTimer=0;
  let historyRetryTimer=0;
  let inFlight=null;
  let historyInFlight=null;
  let captureInFlight=Promise.resolve();
  let metaWriteInFlight=Promise.resolve();
  let kernelReady=Promise.resolve(null);
  let importInProgress=false;
  let startupState='pending';
  let startupInFlight=null;
  let recentEditContext=null;

  function parse(raw,fallback=null){try{return raw?JSON.parse(raw):fallback}catch{return fallback}}
  function uuid(){return crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)})}
  function now(){return new Date().toISOString()}
  function workspaceToken(){
    const secret=typeof global.cloudCfg==='function'?(global.cloudCfg()?.syncKey||''):'';
    if(!secret)return 'local';
    let hashA=2166136261,hashB=2246822519;
    for(let index=0;index<secret.length;index++){
      const code=secret.charCodeAt(index);
      hashA^=code;
      hashA=Math.imul(hashA,16777619);
      hashB^=code+index;
      hashB=Math.imul(hashB,3266489917);
    }
    return 'w-'+(hashA>>>0).toString(16).padStart(8,'0')+(hashB>>>0).toString(16).padStart(8,'0');
  }
  function metaStorageKey(){return META_PREFIX+workspaceToken()}
  function meta(){
    const scopedKey=metaStorageKey();
    let saved=parse(localStorage.getItem(scopedKey),null);
    if(!saved){
      const legacy=parse(localStorage.getItem(META_KEY),{});
      const token=workspaceToken();
      if(!legacy.scopedWorkspace||legacy.scopedWorkspace===token){
        saved={...legacy,scopedWorkspace:token};
        localStorage.setItem(META_KEY,JSON.stringify({...legacy,scopedWorkspace:token}));
      }else saved={};
    }
    const value={
      version:3,
      deviceId:uuid(),
      serverRevision:0,
      lastPayloadHash:'',
      lastCommitAt:'',
      lastLocalAt:'',
      lastBackupAt:'',
      dirty:false,
      generation:0,
      committedGeneration:0,
      localState:'saved',
      serverState:'unconfigured',
      retryCount:0,
      lastError:'',
      lastConflict:'',
      restorePending:false,
      startupChecked:false,
      lastHistoryHash:'',
      lastHistoryAt:'',
      scopedWorkspace:workspaceToken(),
      ...saved,
    };
    localStorage.setItem(scopedKey,JSON.stringify(value));
    return value;
  }
  function setMeta(patch){
    const value={...meta(),...patch};
    localStorage.setItem(metaStorageKey(),JSON.stringify(value));
    const syncMetaKey='sync:'+workspaceToken();
    metaWriteInFlight=metaWriteInFlight
      .then(()=>kernelReady)
      .then(()=>kernel?.writeMeta(syncMetaKey,value))
      .catch(()=>{});
    updateStatusUI(value);
    return value;
  }
  function cfg(){return typeof global.cloudCfg==='function'?global.cloudCfg():null}
  function enabled(){const c=cfg();return !!(c?.url&&c?.anonKey&&c?.syncKey)}
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
  async function sha256(value){const digest=await crypto.subtle.digest('SHA-256',enc.encode(value));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}
  async function ids(secret){return {syncId:await sha256('ipe-learning-os:id:'+secret),writeHash:await sha256('ipe-learning-os:write:'+secret)}}
  function stable(value){
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  function appData(value){
    const settings={...(value?.settings||{})};
    delete settings.supabaseSync;
    return {version:value?.version||4,progress:value?.progress||{},notes:value?.notes||{},settings};
  }
  function emptyAtlas(){return {concepts:[],frames:[],keywords:[],objects:[]}}
  function emptyBridge(){return {links:[],orphanedLinks:[],catalog:[]}}

  function pendingPayload(){
    const pending=parse(localStorage.getItem(PENDING_IMPORT_KEY),null);
    if(pending?.atlas&&pending?.bridge&&pending?.app)return {version:2,app:appData(pending.app),atlas:pending.atlas,bridge:pending.bridge};
    return null;
  }
  function legacyPayload(){
    const atlas=typeof global.v17StorageGet==='function'
      ?global.v17StorageGet(ATLAS_KEY)
      :parse(localStorage.getItem(ATLAS_KEY),null);
    const bridge=typeof global.bridge==='function'
      ?global.bridge()
      :parse(localStorage.getItem(BRIDGE_KEY),null);
    const currentApp=typeof global.__ipeGetAppState==='function'
      ?global.__ipeGetAppState()
      :parse(localStorage.getItem(APP_KEY),{});
    return {version:2,app:appData(currentApp),atlas:atlas||emptyAtlas(),bridge:bridge||emptyBridge()};
  }
  function localPayload(){
    const canonical=kernel?.peekSnapshot()?.payload;
    return canonical||legacyPayload();
  }
  async function collectPayload({flush=true}={}){
    if(flush&&typeof global.v17FlushAllStores==='function'){
      const flushed=await global.v17FlushAllStores();
      const payload={
        version:2,
        app:appData(flushed?.app||global.__ipeGetAppState?.()||{}),
        atlas:flushed?.atlas||emptyAtlas(),
        bridge:flushed?.bridge||emptyBridge(),
      };
      localStorage.setItem(ATLAS_KEY,JSON.stringify(payload.atlas));
      localStorage.setItem(BRIDGE_KEY,JSON.stringify(payload.bridge));
      localStorage.setItem(APP_KEY,JSON.stringify(global.__ipeGetAppState?.()||flushed?.app||{}));
      return payload;
    }
    return legacyPayload();
  }
  function validate(payload){
    const errors=[],warnings=[];
    const concepts=Array.isArray(payload?.atlas?.concepts)?payload.atlas.concepts:[];
    const objects=Array.isArray(payload?.atlas?.objects)?payload.atlas.objects:[];
    const links=Array.isArray(payload?.bridge?.links)?payload.bridge.links:[];
    const orphanedLinks=Array.isArray(payload?.bridge?.orphanedLinks)?payload.bridge.orphanedLinks:[];
    const conceptIds=new Set();
    for(const concept of concepts){
      if(!concept?.id)errors.push('ID가 없는 개념이 있음');
      else if(conceptIds.has(concept.id))errors.push('중복 개념 ID: '+concept.id);
      else conceptIds.add(concept.id);
    }
    const dangling=links.filter(link=>!conceptIds.has(link?.conceptId));
    if(dangling.length)errors.push(`본문 없는 학습 연결 ${dangling.length}개`);
    for(const concept of concepts){
      for(const parent of concept.parents||[])if(!conceptIds.has(parent))errors.push(`${concept.id}: 존재하지 않는 상위 개념 ${parent}`);
      for(const related of concept.related||[])if(!conceptIds.has(related))errors.push(`${concept.id}: 존재하지 않는 연관 개념 ${related}`);
    }
    const entityIds=new Set([...conceptIds,...objects.map(object=>object?.id).filter(Boolean)]);
    for(const frame of payload?.atlas?.frames||[])for(const member of frame.members||[])if(!entityIds.has(member))errors.push(`${frame.id}: 존재하지 않는 프레임 멤버 ${member}`);
    if(!concepts.length&&(links.length||orphanedLinks.length))errors.push(`Atlas 개념은 0개인데 보존된 학습 연결이 ${links.length+orphanedLinks.length}개 있음`);
    else if(!concepts.length)warnings.push('Atlas 개념이 0개임');
    return {ok:!errors.length,errors:[...new Set(errors)],warnings,dangling,conceptCount:concepts.length,linkCount:links.length,orphanCount:orphanedLinks.length};
  }
  function counts(payload){
    return {
      progress:Object.keys(payload?.app?.progress||{}).length,
      notes:Object.keys(payload?.app?.notes||{}).length,
      concepts:Array.isArray(payload?.atlas?.concepts)?payload.atlas.concepts.length:0,
      frames:Array.isArray(payload?.atlas?.frames)?payload.atlas.frames.length:0,
      objects:Array.isArray(payload?.atlas?.objects)?payload.atlas.objects.length:0,
      activeLinks:Array.isArray(payload?.bridge?.links)?payload.bridge.links.length:0,
      orphanedLinks:Array.isArray(payload?.bridge?.orphanedLinks)?payload.bridge.orphanedLinks.length:0,
    };
  }
  function isPristinePayload(payload){
    const tally=counts(payload);
    return tally.progress===0&&tally.notes===0&&tally.concepts===0&&tally.frames===0&&
      tally.objects===0&&tally.activeLinks===0&&tally.orphanedLinks===0;
  }
  function legacyMigrationPayload(){
    const base=legacyPayload();
    const pendingRecord=parse(localStorage.getItem(PENDING_IMPORT_KEY),null);
    const candidate=pendingRecord?.app&&pendingRecord?.atlas&&pendingRecord?.bridge
      ?{version:2,app:appData(pendingRecord.app),atlas:pendingRecord.atlas,bridge:pendingRecord.bridge}
      :null;
    const baseAudit=validate(base);
    const candidateAudit=candidate?validate(candidate):null;
    if(candidateAudit?.ok&&(meta().restorePending||!baseAudit.ok))return candidate;
    return base;
  }
  async function initializeKernel(){
    if(!kernel)return null;
    kernel.configure({
      legacyReader:async()=>legacyMigrationPayload(),
      validate,
      counts,
      hash:payload=>sha256(stable(payload)),
    });
    let result=await kernel.initialize();
    let recoveredLegacy=false;
    const dirtyMarker=parse(localStorage.getItem(LEGACY_DIRTY_KEY),null);
    if(dirtyMarker){
      const legacy=legacyMigrationPayload();
      const audit=validate(legacy);
      if(!audit.ok)throw new Error('비정상 종료 데이터 복구 차단: '+audit.errors.join(' / '));
      const canonical=await kernel.readSnapshot();
      const legacyHash=await sha256(stable(legacy));
      if(canonical?.payloadHash!==legacyHash){
        if(canonical?.payload)await kernel.checkpoint(canonical.payload,{
          source:'pre-crash-recovery',
          metadata:{dirtyMarker},
        });
        const recovered=await kernel.writeSnapshot(legacy,{
          reason:'crash-recovery',
          enqueue:false,
          source:'legacy-write-ahead-mirror',
        });
        const verified=await kernel.readSnapshot();
        if(verified?.payloadHash!==recovered.snapshot.payloadHash)throw new Error('비정상 종료 데이터 복구 검증 실패');
        result={...result,recovered:true,snapshot:verified};
        recoveredLegacy=true;
      }
      localStorage.removeItem?.(LEGACY_DIRTY_KEY);
    }
    const storedMeta=await kernel.readMeta('sync:'+workspaceToken());
    let merged;
    if(storedMeta){
      merged={...meta(),...storedMeta,scopedWorkspace:workspaceToken()};
    }else{
      merged=meta();
    }
    if(recoveredLegacy)merged={
      ...merged,
      dirty:true,
      localState:'saved',
      serverState:enabled()?'queued':'unconfigured',
      lastReason:'crash-recovery',
      lastLocalAt:now(),
    };
    localStorage.setItem(metaStorageKey(),JSON.stringify(merged));
    await kernel.writeMeta('sync:'+workspaceToken(),merged);
    updateStatusUI(merged);

    const canonical=await kernel.readSnapshot();
    const live=legacyPayload();
    if(canonical?.payload&&canonical.payloadHash!==await sha256(stable(live))){
      const currentApp=global.__ipeGetAppState?.()||parse(localStorage.getItem(APP_KEY),{});
      const localSync=currentApp?.settings?.supabaseSync||cfg()||{};
      const applied={
        ...canonical.payload,
        app:{
          ...canonical.payload.app,
          settings:{...(canonical.payload.app?.settings||{}),supabaseSync:localSync},
        },
      };
      if(typeof global.applySnapshotPayload==='function')global.applySnapshotPayload(applied);
      else mirrorPayload(canonical.payload);
    }
    return result;
  }
  async function ensureKernel(){return kernelReady}
  async function remoteDescriptor(expectedRevision=meta().serverRevision){
    if(!enabled())return null;
    const c=cfg();
    const identity=await ids(c.syncKey);
    return {
      workspaceKey:identity.syncId,
      syncId:identity.syncId,
      writeHash:identity.writeHash,
      expectedRevision:Number(expectedRevision)||0,
      deviceId:meta().deviceId,
      deviceAlias:String(cfg()?.deviceAlias||'내 기기').trim().slice(0,80)||'내 기기',
    };
  }
  function mirrorPayload(payload){
    const currentApp=global.__ipeGetAppState?.()||parse(localStorage.getItem(APP_KEY),{});
    const localSync=currentApp?.settings?.supabaseSync||cfg()||{};
    const app={
      ...currentApp,
      version:payload.app?.version||currentApp?.version||4,
      progress:payload.app?.progress||{},
      notes:payload.app?.notes||{},
      settings:{...(currentApp?.settings||{}),...(payload.app?.settings||{}),supabaseSync:localSync},
    };
    localStorage.setItem(APP_KEY,JSON.stringify(app));
    localStorage.setItem(ATLAS_KEY,JSON.stringify(payload.atlas));
    localStorage.setItem(BRIDGE_KEY,JSON.stringify(payload.bridge));
    localStorage.removeItem?.(LEGACY_DIRTY_KEY);
    return app;
  }
  async function persistPayload(payload,{reason='data-change',enqueue=enabled(),source='normalized-sync'}={}){
    const audit=validate(payload);
    if(!audit.ok)throw new Error('로컬 통합 저장 차단: '+audit.errors.join(' / '));
    await ensureKernel();
    if(!kernel){
      mirrorPayload(payload);
      return {snapshot:{payload,payloadHash:await sha256(stable(payload)),counts:counts(payload)},operation:null,audit};
    }
    const remote=enqueue?await remoteDescriptor():null;
    const result=await kernel.writeSnapshot(payload,{reason,remote,enqueue:!!remote,source});
    const verified=await kernel.readSnapshot();
    if(verified?.payloadHash!==result.snapshot.payloadHash)throw new Error('통합 스냅샷 재검증 실패');
    mirrorPayload(payload);
    return result;
  }
  function captureCurrent(reason,{flush=false,enqueue=enabled()&&startupState==='ready'}={}){
    const task=captureInFlight.then(async()=>{
      setMeta({localState:'saving',lastError:''});
      const payload=await collectPayload({flush});
      const result=await persistPayload(payload,{reason,enqueue});
      setMeta({
        localState:'saved',
        lastLocalAt:now(),
        localGeneration:Number(result.snapshot?.generation)||Number(meta().generation)||0,
        serverState:enqueue&&enabled()?'queued':meta().serverState,
      });
      return {...result,payload};
    });
    captureInFlight=task.catch(error=>{
      setMeta({localState:'failed',lastError:error.message});
    });
    return task;
  }
  async function rpc(name,body){
    const c=cfg();
    if(!c?.url||!c?.anonKey)throw new Error('Supabase 연결 정보가 없음');
    let response;
    try{
      response=await fetch(`${c.url.replace(/\/$/,'')}/rest/v1/rpc/${name}`,{
        method:'POST',
        headers:{apikey:c.anonKey,Authorization:`Bearer ${c.anonKey}`,'Content-Type':'application/json'},
        body:JSON.stringify(body),
      });
    }catch(error){
      const wrapped=new Error(navigator.onLine===false?'오프라인 상태':'네트워크 연결 실패');
      wrapped.cause=error;
      wrapped.transient=true;
      throw wrapped;
    }
    const text=await response.text();
    let data=null;
    try{data=text?JSON.parse(text):null}catch{data=text}
    if(!response.ok){
      const message=typeof data==='string'?data:(data?.message||`HTTP ${response.status}`);
      const error=new Error(message);
      error.status=response.status;
      error.detail=data?.details||data?.detail||'';
      error.transient=response.status===429||response.status>=500;
      throw error;
    }
    return data;
  }
  async function head(){
    const c=cfg();
    if(!enabled())throw new Error('Supabase 연결 정보가 없음');
    const identity=await ids(c.syncKey);
    try{
      const rows=await rpc('ipe_load_working_head',{p_sync_id:identity.syncId,p_write_hash:identity.writeHash});
      return Array.isArray(rows)?rows[0]||null:rows;
    }catch(error){
      if(/invalid sync key/i.test(error.message))return null;
      throw error;
    }
  }

  function setLocalSaved(message='로컬 저장됨'){
    setMeta({localState:'saved',lastLocalAt:now(),lastLocalMessage:message});
  }
  function scheduleNamedHistory(){
    clearTimeout(historyIdleTimer);
    historyIdleTimer=setTimeout(()=>saveNamedHistory('idle').catch(()=>{}),HISTORY_IDLE_MS);
    if(!historyContinuousTimer){
      historyContinuousTimer=setTimeout(()=>{
        historyContinuousTimer=0;
        saveNamedHistory('continuous').catch(()=>{});
      },HISTORY_CONTINUOUS_MS);
    }
  }
  function markChanged(reason='data-change',delay=700){
    const current=meta();
    const nextGeneration=Number(current.generation||0)+1;
    setMeta({
      dirty:true,
      generation:nextGeneration,
      localState:'saving',
      lastReason:reason,
      serverState:enabled()?'queued':'unconfigured',
      lastError:'',
    });
    captureCurrent(reason,{flush:false,enqueue:enabled()&&startupState==='ready'}).catch(()=>{});
    scheduleNamedHistory();
    clearTimeout(commitTimer);
    if(importInProgress||current.restorePending)return;
    if(enabled())commitTimer=setTimeout(()=>flushNow(reason,{manual:false}).catch(()=>{}),delay);
  }
  function acceptAtlasSnapshot(atlas,bridge,{reason='atlas-data-change',editContext=null}={}){
    if(editContext?.name)recentEditContext={...editContext,at:Date.now()};
    if(atlas)localStorage.setItem(ATLAS_KEY,JSON.stringify(atlas));
    if(bridge)localStorage.setItem(BRIDGE_KEY,JSON.stringify(bridge));
    const current=meta();
    setMeta({
      dirty:true,
      generation:Number(current.generation||0)+1,
      localState:'saving',
      lastReason:reason,
      serverState:enabled()?'queued':'unconfigured',
      lastError:'',
    });
    const payload={
      version:2,
      app:appData(global.__ipeGetAppState?.()||parse(localStorage.getItem(APP_KEY),{})),
      atlas:atlas||emptyAtlas(),
      bridge:bridge||emptyBridge(),
    };
    const task=captureInFlight.then(async()=>{
      const result=await persistPayload(payload,{reason,enqueue:enabled()&&startupState==='ready',source:'atlas-parent-commit'});
      setMeta({localState:'saved',lastLocalAt:now(),localGeneration:Number(result.snapshot?.generation)||0});
      return result;
    });
    captureInFlight=task.catch(error=>setMeta({localState:'failed',lastError:error.message}));
    scheduleNamedHistory();
    clearTimeout(commitTimer);
    if(!importInProgress&&!current.restorePending&&enabled()){
      commitTimer=setTimeout(()=>flushNow(reason,{manual:false}).catch(()=>{}),500);
    }
    return task;
  }
  function retryLater(reason,delay=1500){
    clearTimeout(retryTimer);
    const current=meta();
    const attempt=Math.min(6,Number(current.retryCount||0)+1);
    setMeta({retryCount:attempt,serverState:navigator.onLine===false?'offline':'failed'});
    retryTimer=setTimeout(()=>flushNow(reason,{manual:false}).catch(()=>{}),delay);
  }
  async function commitOperation(operation,{verify=true}={}){
    let result;
    try{
      result=await rpc('ipe_commit_working_state',{
        p_sync_id:operation.syncId,
        p_write_hash:operation.writeHash,
        p_expected_revision:Number(operation.expectedRevision)||0,
        p_operation_id:operation.operationId,
        p_device_id:operation.deviceId,
        p_payload_hash:operation.payloadHash,
        p_app:operation.payload.app,
        p_atlas:operation.payload.atlas,
        p_bridge:operation.payload.bridge,
        p_protocol_version:CLIENT_PROTOCOL_VERSION,
      });
    }catch(error){
      if(/revision conflict|40001/i.test(error.message+' '+error.detail)){
        await kernel.markFailed(operation.operationId,error,{conflict:true});
        setMeta({dirty:true,serverState:'conflict',lastConflictAt:now(),lastConflict:error.message,lastError:error.message});
        throw new Error('다른 디바이스가 먼저 저장함. 로컬 데이터는 보존했고 자동 덮어쓰기를 중단함');
      }
      const attempt=Math.min(6,Number(operation.attemptCount||1));
      const delay=Math.min(60000,1500*(2**Math.max(0,attempt-1)));
      await kernel.markFailed(operation.operationId,error,{delayMs:delay});
      setMeta({dirty:true,serverState:navigator.onLine===false?'offline':'failed',lastError:error.message});
      if(error.transient||navigator.onLine===false)retryLater('durable-outbox-retry',delay);
      throw error;
    }
    const row=Array.isArray(result)?result[0]:result;
    const savedRevision=Number(row?.revision)||Number(operation.expectedRevision)||0;
    if(verify){
      const remote=await head();
      if(!remote||Number(remote.revision)!==savedRevision||remote.payload_hash!==operation.payloadHash){
        const error=new Error('저장 후 서버 버전/hash 검증 실패');
        await kernel.markFailed(operation.operationId,error,{delayMs:1500});
        setMeta({dirty:true,serverState:'failed',lastError:error.message});
        retryLater('verify-retry',1500);
        throw error;
      }
    }
    await kernel.markAcked(operation.operationId,{
      revision:savedRevision,
      committedAt:row?.committed_at||now(),
      payloadHash:operation.payloadHash,
    });
    await kernel.rebasePending(operation.workspaceKey,savedRevision);
    const canonical=await kernel.readSnapshot();
    const pending=await kernel.pendingCount(operation.workspaceKey);
    const clean=canonical?.payloadHash===operation.payloadHash&&pending===0;
    setMeta({
      serverRevision:savedRevision,
      lastPayloadHash:operation.payloadHash,
      lastCommitAt:row?.committed_at||now(),
      dirty:!clean,
      committedGeneration:Number(operation.generation)||Number(meta().generation)||0,
      serverState:clean?'saved':'queued',
      retryCount:0,
      lastReason:operation.reason,
      lastConflict:'',
      lastError:'',
      restorePending:false,
    });
    return {row,payloadHash:operation.payloadHash,revision:savedRevision,operationId:operation.operationId,replayed:!!row?.replayed};
  }
  function editContext(){
    const provided=global.__ipeGetEditContext?.()||{};
    const app=global.__ipeGetAppState?.()||{};
    const recent=recentEditContext&&Date.now()-recentEditContext.at<30*60*1000?recentEditContext:{};
    return {
      subject:String(recent.subject||provided.subject||'').trim(),
      name:String(recent.name||provided.name||'').trim(),
      itemId:String(provided.itemId||app.studyItemId||'').trim(),
      activeTab:String(provided.activeTab||app.activeTab||'').trim(),
      conceptId:String(recent.conceptId||'').trim(),
    };
  }
  function historyStamp(date=new Date()){
    const pad=value=>String(value).padStart(2,'0');
    return `${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function historyLabel(context=editContext(),date=new Date()){
    const device=String(cfg()?.deviceAlias||'내 기기').trim()||'내 기기';
    const scope=context.subject&&context.name
      ?`${context.subject} › ${context.name}`
      :(context.name||context.subject||'전체 학습 상태');
    return `${scope} · ${device} · ${historyStamp(date)}`;
  }
  async function commitHistoryOperation(operation){
    try{
      const result=await rpc('ipe_create_history_snapshot',{
        p_sync_id:operation.syncId,
        p_write_hash:operation.writeHash,
        p_expected_revision:Number(operation.expectedRevision)||0,
        p_operation_id:operation.operationId,
        p_device_id:operation.deviceId,
        p_device_alias:operation.deviceAlias,
        p_payload_hash:operation.payloadHash,
        p_label:operation.label,
        p_reason:operation.reason,
        p_context:operation.context||{},
        p_app:operation.payload.app,
        p_atlas:operation.payload.atlas,
        p_bridge:operation.payload.bridge,
        p_protocol_version:CLIENT_PROTOCOL_VERSION,
      });
      const row=Array.isArray(result)?result[0]:result;
      await kernel.markHistoryAcked(operation.operationId,{
        historyId:row?.history_id,
        createdAt:row?.created_at,
        payloadHash:operation.payloadHash,
      });
      setMeta({
        lastHistoryHash:operation.payloadHash,
        lastHistoryAt:row?.created_at||now(),
        lastHistoryLabel:operation.label,
        lastError:'',
      });
      return row;
    }catch(error){
      const delay=Math.min(60000,1500*(2**Math.max(0,Number(operation.attemptCount||1)-1)));
      await kernel.markHistoryFailed(operation.operationId,error,{delayMs:delay});
      setMeta({lastError:'복구 기록 저장 실패: '+error.message});
      clearTimeout(historyRetryTimer);
      historyRetryTimer=setTimeout(()=>drainHistory({workspaceKey:operation.workspaceKey}).catch(()=>{}),delay);
      throw error;
    }
  }
  async function drainHistory(remote){
    const locked=await kernel.withWriterLock(remote.workspaceKey,async()=>{
      let latest=null;
      while(true){
        const operation=await kernel.claimNextHistory(remote.workspaceKey);
        if(!operation)break;
        latest=await commitHistoryOperation(operation);
      }
      return latest;
    });
    return locked.acquired?locked.value:{deferred:true};
  }
  async function saveNamedHistory(trigger='manual',{skipFlush=false}={}){
    if(historyInFlight)return historyInFlight;
    const task=(async()=>{
      clearTimeout(historyIdleTimer);
      clearTimeout(historyContinuousTimer);
      historyIdleTimer=0;
      historyContinuousTimer=0;
      if(!enabled()||!kernel)return {localOnly:true};
      if(!skipFlush)await flushNow(`history-${trigger}`,{manual:false});
      if(meta().serverState!=='saved')return {deferred:true};
      const snapshot=await kernel.readSnapshot();
      if(!snapshot||snapshot.payloadHash===meta().lastHistoryHash)return {skipped:true};
      const context=editContext();
      const remote=await remoteDescriptor();
      await kernel.ensureHistoryOutbox(remote,{
        reason:trigger,
        label:historyLabel(context),
        context,
      });
      return drainHistory(remote);
    })();
    historyInFlight=task;
    try{return await task}
    finally{if(historyInFlight===task)historyInFlight=null}
  }
  async function protectRemoteBeforeOverwrite(reason){
    if(!enabled())return null;
    const remote=await head();
    if(!remote||remote.payload_hash===meta().lastProtectedRemoteHash)return null;
    const identity=await ids(cfg().syncKey);
    const context={scope:'server-head',reason};
    const label=`서버 덮어쓰기 전 · ${String(cfg()?.deviceAlias||'내 기기').trim()||'내 기기'} · ${historyStamp()}`;
    const rows=await rpc('ipe_create_history_snapshot',{
      p_sync_id:identity.syncId,
      p_write_hash:identity.writeHash,
      p_expected_revision:Number(remote.revision)||0,
      p_operation_id:uuid(),
      p_device_id:meta().deviceId,
      p_device_alias:String(cfg()?.deviceAlias||'내 기기').trim()||'내 기기',
      p_payload_hash:remote.payload_hash,
      p_label:label,
      p_reason:reason,
      p_context:context,
      p_app:remote.app_state,
      p_atlas:remote.atlas_state,
      p_bridge:remote.bridge_state,
      p_protocol_version:CLIENT_PROTOCOL_VERSION,
    });
    setMeta({lastProtectedRemoteHash:remote.payload_hash});
    return Array.isArray(rows)?rows[0]:rows;
  }
  async function commitOnce(reason,{verify=true}={}){
    if(enabled()&&startupState!=='ready')await ensureStartupReady();
    const start=meta();
    setMeta({serverState:enabled()?'saving':'unconfigured',lastError:''});
    let captured;
    try{
      captured=await captureCurrent(reason,{flush:true,enqueue:false});
      setLocalSaved('App·Atlas·Bridge 통합 스냅샷 저장됨');
    }catch(error){
      setMeta({
        localState:'failed',
        serverState:start.serverState==='conflict'?'conflict':(start.dirty?'queued':start.serverState),
        lastError:error.message,
      });
      throw new Error('로컬 통합 저장 실패: '+error.message);
    }
    if(start.serverState==='conflict'){
      setMeta({dirty:true,serverState:'conflict'});
      throw new Error('서버 충돌을 먼저 해결해야 함 · 서버 최신 데이터 적용 또는 로컬 데이터로 서버 갱신을 선택해.');
    }
    if(!enabled()){
      setMeta({dirty:true,localState:'saved',serverState:'unconfigured',lastError:''});
      return {localOnly:true,audit:captured.audit,payloadHash:captured.snapshot?.payloadHash};
    }
    if(!kernel)throw new Error('영속 저장 커널이 로드되지 않음');
    if(start.restorePending)await protectRemoteBeforeOverwrite('restore-overwrite');
    else if(/초기화|reset/i.test(`${reason} ${start.lastReason||''}`))await protectRemoteBeforeOverwrite('data-reset');
    const remote=await remoteDescriptor();
    const pendingBefore=await kernel.pendingCount(remote.workspaceKey);
    if(captured.snapshot?.payloadHash===meta().lastPayloadHash&&pendingBefore===0){
      setMeta({dirty:false,serverState:'saved',retryCount:0,restorePending:false});
      return {skipped:true,revision:meta().serverRevision,audit:captured.audit,payloadHash:captured.snapshot.payloadHash};
    }
    await kernel.ensureOutbox(remote,{reason});
    const locked=await kernel.withWriterLock(remote.workspaceKey,async()=>{
      let latest=null;
      while(true){
        const operation=await kernel.claimNext(remote.workspaceKey);
        if(!operation)break;
        latest=await commitOperation(operation,{verify});
      }
      return latest;
    });
    if(!locked.acquired){
      setMeta({dirty:true,serverState:'queued',lastError:''});
      clearTimeout(retryTimer);
      retryTimer=setTimeout(()=>flushNow('writer-handoff',{manual:false}).catch(()=>{}),500);
      return {deferred:true};
    }
    return locked.value||{skipped:true,revision:meta().serverRevision,audit:captured.audit,payloadHash:captured.snapshot?.payloadHash};
  }
  async function flushNow(reason='manual',{manual=true}={}){
    clearTimeout(commitTimer);
    clearTimeout(retryTimer);
    if(inFlight)return inFlight;
    const task=commitOnce(reason,{verify:true});
    inFlight=task;
    let result;
    try{
      result=await task;
    }finally{
      if(inFlight===task)inFlight=null;
    }
    return result;
  }

  async function createBackup(){
    setMeta({localState:'saving'});
    const captured=await captureCurrent('manual-backup',{flush:true,enqueue:false});
    const payload=captured.payload;
    const audit=validate(payload);
    if(!audit.ok){
      setMeta({localState:'failed',lastError:audit.errors.join(' / ')});
      throw new Error('백업 생성 차단: '+audit.errors.join(' / '));
    }
    const payloadHash=await sha256(stable(payload));
    const createdAt=now();
    const envelope={
      format:BACKUP_FORMAT,
      schemaVersion:3,
      createdAt,
      source:'manual-file',
      revision:Number(meta().serverRevision)||0,
      payloadHash,
      counts:counts(payload),
      data:payload,
    };
    const blob=new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'});
    const anchor=document.createElement('a');
    anchor.href=URL.createObjectURL(blob);
    anchor.download=`IPE_LearningOS_backup_${createdAt.slice(0,10)}_${createdAt.slice(11,16).replace(':','')}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    setMeta({localState:'saved',lastLocalAt:createdAt,lastBackupAt:createdAt,lastBackupHash:payloadHash});
    global.showToast?.(`통합 백업 생성 완료 · 개념 ${envelope.counts.concepts} · 연결 ${envelope.counts.activeLinks}`);
    return envelope;
  }
  function normalizeBackup(parsed,current){
    let candidate=null;
    if(parsed?.format===BACKUP_FORMAT&&parsed?.data)candidate=parsed.data;
    else if(parsed?.data?.app&&parsed?.data?.atlas&&parsed?.data?.bridge)candidate=parsed.data;
    else if(parsed?.app&&parsed?.atlas&&parsed?.bridge)candidate={version:2,app:appData(parsed.app),atlas:parsed.atlas,bridge:parsed.bridge};
    else if(parsed?.atlas&&parsed?.bridge)candidate={version:2,app:appData(parsed.app||current.app),atlas:parsed.atlas,bridge:parsed.bridge};
    else if(Array.isArray(parsed?.concepts)&&Array.isArray(parsed?.frames))candidate={version:2,app:current.app,atlas:parsed,bridge:current.bridge};
    if(!candidate)throw new Error('지원하지 않는 백업 형식');
    const backupConcepts=Array.isArray(candidate.atlas?.concepts)?candidate.atlas.concepts:[];
    const currentConcepts=Array.isArray(current.atlas?.concepts)?current.atlas.concepts:[];
    const backupLinks=Array.isArray(candidate.bridge?.links)?candidate.bridge.links:[];
    if(!backupConcepts.length&&backupLinks.length&&currentConcepts.length){
      return {
        ...candidate,
        atlas:current.atlas,
        recoveryNote:`백업의 Atlas 본문이 비어 있어 현재 로컬 Atlas 개념 ${currentConcepts.length}개를 결합한다.`,
      };
    }
    return candidate;
  }
  function archiveDangling(payload){
    const audit=validate(payload);
    if(!audit.dangling.length)return {payload,audit,removed:0};
    const danglingKeys=new Set(audit.dangling.map(link=>`${link.itemId}\u0000${link.conceptId}`));
    const archived=audit.dangling.map(link=>({...link,reason:'missing_concept_body',archivedAt:now()}));
    const bridge={
      ...payload.bridge,
      orphanedLinks:[...(payload.bridge.orphanedLinks||[]),...archived],
      links:(payload.bridge.links||[]).filter(link=>!danglingKeys.has(`${link.itemId}\u0000${link.conceptId}`)),
    };
    const next={...payload,bridge};
    return {payload:next,audit:validate(next),removed:audit.dangling.length};
  }
  async function applyCandidate(candidate,{source='file'}={}){
    const currentCapture=await captureCurrent('pre-import-checkpoint',{flush:true,enqueue:false});
    const current=currentCapture.payload;
    let prepared={version:2,app:appData(candidate.app),atlas:candidate.atlas,bridge:candidate.bridge};
    if(!prepared.atlas?.concepts?.length&&((prepared.bridge?.links||[]).length||(prepared.bridge?.orphanedLinks||[]).length))throw new Error('빈 Atlas와 학습 연결이 함께 든 백업은 적용할 수 없음');
    const archived=archiveDangling(prepared);
    prepared=archived.payload;
    if(!archived.audit.ok)throw new Error('백업 적용 차단: '+archived.audit.errors.join(' / '));
    const before=counts(current),after=counts(prepared);
    const approved=confirm(
      `백업을 로컬에 적용할까?\n\n`+
      (candidate.recoveryNote?candidate.recoveryNote+'\n\n':'')+
      `진도 ${before.progress} → ${after.progress}\n`+
      `개념 ${before.concepts} → ${after.concepts}\n`+
      `활성 연결 ${before.activeLinks} → ${after.activeLinks}\n`+
      `고아 연결 ${before.orphanedLinks} → ${after.orphanedLinks}\n\n`+
      `현재 데이터는 적용 전에 체크포인트로 보존되며 서버에는 자동 반영하지 않는다.`
    );
    if(!approved)return {cancelled:true};
    localStorage.setItem(PREIMPORT_KEY,JSON.stringify({savedAt:now(),source,payload:current}));
    await ensureKernel();
    await kernel?.checkpoint(current,{source:'pre-import',metadata:{importSource:source}});
    const currentApp=global.__ipeGetAppState?.()||parse(localStorage.getItem(APP_KEY),{});
    const currentSync={...(currentApp?.settings?.supabaseSync||cfg()||{})};
    const appliedApp={...candidate.app,settings:{...(candidate.app?.settings||{}),supabaseSync:currentSync}};
    const canonical={version:2,app:appData(appliedApp),atlas:prepared.atlas,bridge:prepared.bridge};
    // Compatibility recovery marker only. Canonical reads never prefer this key.
    localStorage.setItem(PENDING_IMPORT_KEY,JSON.stringify({savedAt:now(),source,app:appliedApp,atlas:prepared.atlas,bridge:prepared.bridge}));
    global.__ipeNormalizedImportGuard={atlas:prepared.atlas,bridge:prepared.bridge,until:Date.now()+30000};
    importInProgress=true;
    clearTimeout(commitTimer);
    try{
      if(typeof global.applySnapshotPayload!=='function')throw new Error('가져오기 함수가 준비되지 않음');
      const persisted=await persistPayload(canonical,{reason:'backup-restore',enqueue:false,source:'backup-restore'});
      global.applySnapshotPayload({version:2,app:appliedApp,atlas:prepared.atlas,bridge:prepared.bridge});
      global.invalidateBridgeCache?.();
      await new Promise(resolve=>setTimeout(resolve,450));
      const verified=kernel?await kernel.readSnapshot():persisted.snapshot;
      const appliedAudit=validate(verified?.payload||canonical);
      if(!appliedAudit.ok||appliedAudit.conceptCount!==after.concepts||verified?.payloadHash!==persisted.snapshot?.payloadHash){
        throw new Error('백업 데이터의 원자 적용 확인 실패');
      }
      const currentMeta=meta();
      setMeta({
        dirty:true,
        generation:Number(currentMeta.generation||0)+1,
        localState:'saved',
        lastLocalAt:now(),
        serverState:'restore-pending',
        restorePending:true,
        lastReason:'backup-restore',
        lastError:'',
      });
      global.showToast?.('백업을 로컬에 적용했어. 확인 후 저장을 눌러 서버에 반영해.');
      return {audit:appliedAudit,removedDangling:archived.removed,before,after};
    }finally{
      importInProgress=false;
    }
  }
  async function importFile(file){
    const parsed=parse(await file.text(),null);
    if(!parsed)throw new Error('백업 JSON을 읽을 수 없음');
    const current=localPayload();
    const candidate=normalizeBackup(parsed,current);
    return applyCandidate(candidate,{source:'file'});
  }
  async function importAtlasFile(file){return importFile(file)}

  async function settleBeforeForcedReplace(){
    clearTimeout(commitTimer);
    clearTimeout(retryTimer);
    clearTimeout(historyIdleTimer);
    clearTimeout(historyContinuousTimer);
    clearTimeout(historyRetryTimer);
    const working=inFlight;
    const named=historyInFlight;
    if(working)try{await working}catch{}
    if(named)try{await named}catch{}
  }
  function clearOriginLocalStorage(){
    if(typeof localStorage.clear==='function'){
      localStorage.clear();
      return;
    }
    const keys=[];
    for(let index=0;index<Number(localStorage.length||0);index++){
      const key=localStorage.key?.(index);
      if(key!==null&&key!==undefined)keys.push(key);
    }
    for(const key of keys)localStorage.removeItem(key);
  }
  async function forceReplaceLocal(row,{source='server-force',serverHead=row}={}){
    if(!row)throw new Error('강제 적용할 서버 데이터가 없음');
    const localSync={...(cfg()||{})};
    const candidate={
      version:2,
      app:{
        ...row.app_state,
        settings:{...(row.app_state?.settings||{}),supabaseSync:localSync},
      },
      atlas:row.atlas_state,
      bridge:row.bridge_state,
    };
    const audit=validate(candidate);
    if(!audit.ok)throw new Error('서버 데이터 무결성 오류: '+audit.errors.join(' / '));
    const targetHash=row.payload_hash||await sha256(stable({
      version:2,
      app:appData(candidate.app),
      atlas:candidate.atlas,
      bridge:candidate.bridge,
    }));
    const headHash=serverHead?.payload_hash||targetHash;
    const isCurrentHead=targetHash===headHash;
    await settleBeforeForcedReplace();
    importInProgress=true;
    try{
      await ensureKernel();
      await kernel?.clearAllData();
      clearOriginLocalStorage();
      const canonical={version:2,app:appData(candidate.app),atlas:candidate.atlas,bridge:candidate.bridge};
      // Seed the selected server copy immediately so a later IndexedDB failure
      // cannot leave the browser with a blank localStorage.
      mirrorPayload(canonical);
      await persistPayload(canonical,{reason:source,enqueue:false,source});
      global.applySnapshotPayload(candidate);
      localStorage.removeItem(PENDING_IMPORT_KEY);
      delete global.__ipeNormalizedImportGuard;
      recentEditContext=null;
      startupState='ready';
      setMeta({
        serverRevision:Number(serverHead?.revision)||0,
        lastPayloadHash:headHash,
        lastPullAt:now(),
        lastLocalAt:now(),
        dirty:!isCurrentHead,
        serverState:isCurrentHead?'saved':'restore-pending',
        localState:'saved',
        restorePending:!isCurrentHead,
        generation:isCurrentHead?0:1,
        committedGeneration:0,
        lastReason:source,
        lastConflict:'',
        lastError:'',
      });
      return {row:serverHead,target:row,audit,forced:true,restorePending:!isCurrentHead};
    }finally{
      importInProgress=false;
    }
  }
  function localChangedDuringStartup(){
    const error=new Error('서버 최신본 적용 중 로컬 변경이 감지되어 자동 적용을 중단함');
    error.code='LOCAL_CHANGED_DURING_STARTUP';
    return error;
  }
  async function pull({automatic=false,remote:providedRemote=null,expectedGeneration=null}={}){
    if(!automatic)await settleBeforeForcedReplace();
    const remote=providedRemote||await head();
    if(!remote)throw new Error('서버에 저장된 데이터가 없음');
    if(!automatic)return forceReplaceLocal(remote,{source:'server-latest-force',serverHead:remote});
    const currentMeta=meta();
    if(currentMeta.dirty&&currentMeta.serverState!=='conflict')throw new Error('저장되지 않은 로컬 변경이 있어 원격 적용을 차단함');
    const guardedGeneration=expectedGeneration===null?Number(currentMeta.generation||0):Number(expectedGeneration);
    if(automatic&&Number(currentMeta.generation||0)!==guardedGeneration)throw localChangedDuringStartup();
    const currentCapture=await captureCurrent('pre-pull-checkpoint',{flush:true,enqueue:false});
    if(automatic&&(meta().dirty||Number(meta().generation||0)!==guardedGeneration))throw localChangedDuringStartup();
    const current=currentCapture.payload;
    const localApp=global.__ipeGetAppState?.()||{};
    const candidate={
      version:2,
      app:{...remote.app_state,settings:{...(remote.app_state?.settings||{}),supabaseSync:localApp?.settings?.supabaseSync}},
      atlas:remote.atlas_state,
      bridge:remote.bridge_state,
    };
    const audit=validate(candidate);
    if(!audit.ok)throw new Error('원격 데이터 무결성 오류: '+audit.errors.join(' / '));
    localStorage.setItem(PREPULL_KEY,JSON.stringify({savedAt:now(),payload:current}));
    await ensureKernel();
    await kernel?.checkpoint(current,{source:'pre-pull',metadata:{remoteRevision:Number(remote.revision)||0}});
    const canonical={version:2,app:appData(candidate.app),atlas:candidate.atlas,bridge:candidate.bridge};
    await persistPayload(canonical,{reason:'remote-pull',enqueue:false,source:'remote-revision'});
    if(automatic&&(meta().dirty||Number(meta().generation||0)!==guardedGeneration)){
      const live=await collectPayload({flush:true});
      await persistPayload(live,{reason:'startup-race-recovery',enqueue:false,source:'startup-race-recovery'});
      setMeta({dirty:true,serverState:'conflict',lastConflict:'서버 최신본 적용 중 로컬 변경 감지'});
      throw localChangedDuringStartup();
    }
    global.applySnapshotPayload(candidate);
    if(kernel){
      const identity=await ids(cfg().syncKey);
      await kernel.supersedeOpen(identity.syncId,'remote-revision-selected');
    }
    localStorage.removeItem(PENDING_IMPORT_KEY);
    delete global.__ipeNormalizedImportGuard;
    setMeta({
      serverRevision:Number(remote.revision)||0,
      lastPayloadHash:remote.payload_hash||await sha256(stable(candidate)),
      lastPullAt:now(),
      dirty:false,
      serverState:'saved',
      localState:'saved',
      restorePending:false,
      lastConflict:'',
      lastError:'',
    });
    return {remote,audit};
  }
  async function resolveConflictKeepLocal(){
    if(!enabled())throw new Error('Supabase 연결 정보가 없음');
    if(meta().serverState!=='conflict')throw new Error('해결할 서버 충돌이 없음');
    const remote=await head();
    if(!remote)throw new Error('서버 최신 데이터를 확인할 수 없음');
    const captured=await captureCurrent('conflict-local-checkpoint',{flush:true,enqueue:false});
    if(captured.snapshot?.payloadHash===remote.payload_hash){
      setMeta({
        serverRevision:Number(remote.revision)||0,
        lastPayloadHash:remote.payload_hash,
        dirty:false,
        serverState:'saved',
        lastConflict:'',
        lastError:'',
      });
      return {skipped:true,revision:Number(remote.revision)||0};
    }
    const approved=confirm(
      `서버 최신 데이터와 현재 로컬 데이터가 다르다.\n\n`+
      `현재 로컬 데이터를 우선하여 서버를 갱신할까?\n`+
      `덮어쓰기 전 서버 상태는 이름 있는 복구 기록으로 보존된다.`
    );
    if(!approved)return {cancelled:true};
    await protectRemoteBeforeOverwrite('conflict-keep-local');
    await ensureKernel();
    await kernel.checkpoint(captured.payload,{
      source:'conflict-keep-local',
      metadata:{remoteRevision:Number(remote.revision)||0},
    });
    const identity=await ids(cfg().syncKey);
    await kernel.supersedeOpen(identity.syncId,'explicit-keep-local');
    setMeta({
      serverRevision:Number(remote.revision)||0,
      lastPayloadHash:remote.payload_hash||'',
      dirty:true,
      serverState:'queued',
      lastConflict:'',
      lastError:'',
    });
    const descriptor=await remoteDescriptor(Number(remote.revision)||0);
    await kernel.ensureOutbox(descriptor,{reason:'conflict-keep-local'});
    return flushNow('conflict-keep-local',{manual:true});
  }
  async function history(limit=30){
    const c=cfg(),identity=await ids(c.syncKey);
    return rpc('ipe_list_history',{p_sync_id:identity.syncId,p_write_hash:identity.writeHash,p_limit:limit});
  }
  async function loadHistory(historyId){
    await settleBeforeForcedReplace();
    const c=cfg(),identity=await ids(c.syncKey);
    const serverHead=await head();
    if(!serverHead)throw new Error('서버 최신 데이터를 확인할 수 없음');
    const rows=await rpc('ipe_load_history',{
      p_sync_id:identity.syncId,
      p_write_hash:identity.writeHash,
      p_history_id:historyId,
    });
    const row=Array.isArray(rows)?rows[0]||null:rows;
    if(!row)throw new Error('선택한 복구 기록을 찾을 수 없음');
    const result=await forceReplaceLocal(row,{source:`server-history-force-${historyId}`,serverHead});
    return {...result,historyId};
  }
  async function ensureStartupReady(){
    if(startupState==='ready')return;
    await startupCheck();
    if(startupState!=='ready')throw new Error('서버 최신 상태를 확인하기 전에는 업로드할 수 없음');
  }
  async function startupCheck(){
    if(startupInFlight)return startupInFlight;
    startupState='checking';
    setMeta({serverState:enabled()?'checking':'unconfigured',startupChecked:false,lastError:''});
    const task=(async()=>{
      await ensureKernel();
      if(!enabled()){
        startupState='ready';
        setMeta({serverState:'unconfigured',startupChecked:true});
        return {unconfigured:true};
      }
      if(meta().restorePending){
        startupState='ready';
        setMeta({serverState:'restore-pending',startupChecked:true});
        return {restorePending:true};
      }
      const remote=await head();
      if(!remote){
        startupState='ready';
        setMeta({dirty:true,serverState:'queued',startupChecked:true,lastError:''});
        if(!inFlight)commitTimer=setTimeout(()=>flushNow('startup-bootstrap',{manual:false}).catch(()=>{}),700);
        return {empty:true};
      }
      const payload=localPayload();
      const localHash=await sha256(stable(payload));
      const current=meta();
      const identity=await ids(cfg().syncKey);
      const pending=kernel?await kernel.pendingCount(identity.syncId):0;
      if(localHash===remote.payload_hash){
        if(kernel){
          const rows=await kernel.listOutbox(identity.syncId);
          for(const operation of rows){
            if(['pending','sending'].includes(operation.status)&&operation.payloadHash===remote.payload_hash){
              await kernel.markAcked(operation.operationId,{
                revision:Number(remote.revision)||0,
                committedAt:remote.created_at||now(),
                payloadHash:remote.payload_hash,
              });
            }
          }
        }
        startupState='ready';
        setMeta({
          serverRevision:Number(remote.revision)||0,
          lastPayloadHash:remote.payload_hash,
          dirty:false,
          serverState:'saved',
          startupChecked:true,
          lastCommitAt:remote.created_at||current.lastCommitAt,
          lastError:'',
        });
        return {matched:true};
      }
      const remoteIsNewer=Number(remote.revision)>Number(current.serverRevision);
      const localIsClean=!current.dirty&&pending===0&&(
        (!!current.lastPayloadHash&&localHash===current.lastPayloadHash)||
        (!current.lastPayloadHash&&isPristinePayload(payload))
      );
      if(remoteIsNewer&&localIsClean){
        setMeta({serverState:'applying',lastError:''});
        try{
          await pull({automatic:true,remote,expectedGeneration:Number(current.generation||0)});
        }catch(error){
          if(error.code!=='LOCAL_CHANGED_DURING_STARTUP')throw error;
          startupState='ready';
          setMeta({
            dirty:true,
            serverState:'conflict',
            startupChecked:true,
            lastConflict:'서버 최신본 적용 중 로컬 변경 감지 · 자동 적용 중단',
          });
          return {conflict:true,reason:'local-changed-during-startup'};
        }
        startupState='ready';
        setMeta({startupChecked:true,serverState:'saved'});
        return {fastForwarded:true};
      }
      if(Number(current.serverRevision)===Number(remote.revision)&&(current.dirty||pending>0)){
        startupState='ready';
        setMeta({serverState:'queued',startupChecked:true});
        commitTimer=setTimeout(()=>flushNow('startup-pending',{manual:false}).catch(()=>{}),900);
        return {queued:true};
      }
      startupState='ready';
      setMeta({
        serverState:'conflict',
        startupChecked:true,
        lastConflict:'서버 최신 데이터와 이 기기의 변경이 겹침 · 자동 업로드 중단',
      });
      return {conflict:true};
    })();
    startupInFlight=task;
    try{return await task}
    catch(error){
      startupState='blocked';
      setMeta({serverState:navigator.onLine===false?'offline':'failed',startupChecked:false,lastError:error.message});
      throw error;
    }finally{
      if(startupInFlight===task)startupInFlight=null;
    }
  }

  function localStatus(value){
    if(value.localState==='saving')return {text:'로컬 · 저장 중',tone:'busy'};
    if(value.localState==='failed')return {text:'로컬 · 저장 실패',tone:'error'};
    return {text:'로컬 · 저장됨',tone:'ok'};
  }
  function serverStatus(value){
    const map={
      unconfigured:['서버 · 연결 안 됨','warn'],
      empty:['서버 · 첫 저장 대기','warn'],
      checking:['서버 · 최신 상태 확인 중','busy'],
      applying:['서버 · 최신 데이터 적용 중','busy'],
      queued:['서버 · 저장 대기','warn'],
      saving:['서버 · 저장 중','busy'],
      saved:['서버 · 저장됨','ok'],
      offline:['서버 · 오프라인','warn'],
      conflict:['서버 · 충돌 확인 필요','error'],
      blocked:['서버 · 무결성 차단','error'],
      failed:['서버 · 저장 실패','error'],
      'restore-pending':['서버 · 복구 확인 대기','warn'],
    };
    const selected=map[value.serverState]||map.unconfigured;
    return {text:selected[0],tone:selected[1]};
  }
  function updateStatusUI(value=meta()){
    if(typeof document==='undefined')return;
    const local=localStatus(value),server=serverStatus(value);
    const localEl=document.getElementById('localSyncState');
    const serverEl=document.getElementById('serverSyncState');
    if(localEl){localEl.textContent=local.text;localEl.dataset.tone=local.tone;localEl.title=value.lastLocalAt?`마지막 로컬 저장 ${value.lastLocalAt}`:''}
    if(serverEl){serverEl.textContent=server.text;serverEl.dataset.tone=server.tone;serverEl.title=value.lastError||value.lastConflict||(value.lastCommitAt?`마지막 서버 저장 ${value.lastCommitAt}`:'')}
    const box=document.getElementById('v2SyncStatus');
    if(box)box.innerHTML=statusHtml(value);
  }
  function statusHtml(value=meta()){
    const local=localStatus(value),server=serverStatus(value);
    return `<b>${escapeHtml(local.text)}</b> · <b>${escapeHtml(server.text)}</b>`+
      (value.lastLocalAt?`<br>마지막 로컬 저장: ${escapeHtml(value.lastLocalAt)}`:'')+
      (value.lastCommitAt?`<br>마지막 서버 저장: ${escapeHtml(value.lastCommitAt)}`:'')+
      (value.lastBackupAt?`<br>마지막 파일 백업: ${escapeHtml(value.lastBackupAt)}`:'')+
      (value.lastError?`<br>오류: ${escapeHtml(value.lastError)}`:'')+
      (value.lastConflict?`<br>충돌: ${escapeHtml(value.lastConflict)}`:'');
  }
  function panel(){
    const c=cfg()||{};
    const m=meta();
    return `<section class="panel"><div class="panel-head"><div><div class="panel-title">저장·기록·복구</div><div class="panel-note">App·Atlas·Bridge 전체를 로컬과 서버에 저장하고, 의미 있는 시점만 이름 있는 복구 기록으로 남긴다.</div></div></div><div class="panel-body">`+
      `<div class="cloud-status" id="v2SyncStatus">${statusHtml(m)}</div>`+
      `<div class="cloud-actions"><button class="primary" data-sync-action="save">저장</button><button data-sync-action="backup">통합 백업 다운로드</button><button data-sync-action="pick-import">백업 가져오기</button><button data-sync-action="pull">서버 최신 데이터 강제 적용</button>${m.serverState==='conflict'?'<button data-sync-action="keep-local">로컬 데이터로 서버 갱신</button>':''}<button data-sync-action="history">복구 기록</button><button data-sync-action="audit">무결성 점검</button></div>`+
      `<details style="margin-top:14px"><summary style="cursor:pointer;color:var(--soft);font-weight:800">Supabase 연결·고급 설정</summary><div class="cloud-grid" style="margin-top:12px">`+
      `<div class="setting"><label>Supabase Project URL</label><input id="sbUrl" value="${escapeHtml(c.url||'')}" placeholder="https://xxxxx.supabase.co"></div>`+
      `<div class="setting"><label>Publishable / Anon Key</label><input id="sbAnonKey" type="password" value="${escapeHtml(c.anonKey||'')}"></div>`+
      `<div class="setting"><label>기기 이름</label><input id="sbDeviceAlias" value="${escapeHtml(c.deviceAlias||'')}" placeholder="예: 데스크탑, 맥북"><div class="help">복구 기록 이름에만 사용하며 실제 컴퓨터 이름은 수집하지 않는다.</div></div>`+
      `<div class="setting cloud-wide"><label>동기화 키</label><input id="sbSyncKey" type="password" value="${escapeHtml(c.syncKey||'')}"><div class="help">연결 정보는 이 브라우저에만 저장되며 백업·서버 payload에는 포함되지 않는다.</div></div>`+
      `</div><div class="cloud-actions"><button data-sync-action="save-config">연결 정보 저장·확인</button><button data-sync-action="copy-sql">저장소 SQL 복사</button></div></details>`+
      `</div></section>`;
  }
  function stripLegacySettings(html){
    const template=document.createElement('template');
    template.innerHTML=html;
    for(const section of template.content.querySelectorAll('section.panel')){
      const title=section.querySelector('.panel-title')?.textContent||'';
      if(/Supabase 원격 동기화|데이터 흐름 안정성 점검|정규화 저장소 v2/.test(title))section.remove();
    }
    return template.innerHTML;
  }
  async function handleAction(action,button=null){
    if(action==='save'){
      const result=await flushNow('manual',{manual:true});
      if(!result.localOnly&&!result.deferred)await saveNamedHistory('manual',{skipFlush:true});
      if(result.localOnly)global.showToast?.('로컬 저장 완료 · 서버 연결 정보를 설정하면 자동 동기화돼.');
      else if(result.deferred)global.showToast?.('로컬 저장 완료 · 다른 탭의 서버 저장이 끝나면 이어서 동기화돼.');
      else global.showToast?.(result.skipped?'로컬·서버가 이미 최신 상태야.':'로컬·서버 저장과 복구 기록 생성 완료');
    }
    if(action==='backup')await createBackup();
    if(action==='pick-import')document.getElementById('syncImportFile')?.click();
    if(action==='pull'){
      await pull();
      global.showToast?.('이 기기의 로컬 데이터를 비우고 서버 최신본을 강제 적용했어.');
    }
    if(action==='keep-local')await resolveConflictKeepLocal();
    if(action==='history'){
      const rows=await history();
      const status=document.getElementById('v2SyncStatus');
      if(status)status.innerHTML=(rows||[]).map(row=>
        `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin:6px 0">`+
        `<span>${escapeHtml(row.label)} · 개념 ${row.concept_count} · 연결 ${row.bridge_link_count}</span>`+
        `<button class="small" data-sync-action="restore-history" data-history-id="${escapeHtml(row.history_id)}">이 기록 강제 복구</button></div>`
      ).join('')||'복구 기록 없음';
    }
    if(action==='restore-history'){
      const result=await loadHistory(button?.dataset.historyId);
      global.showToast?.(result.restorePending
        ?'이 기기의 로컬 데이터를 비우고 선택한 복구 기록을 적용했어. 서버까지 되돌리려면 저장을 눌러.'
        :'이 기기의 로컬 데이터를 비우고 선택한 서버 기록을 적용했어.');
    }
    if(action==='audit'){
      const payload=await collectPayload({flush:true});
      const audit=validate(payload);
      if(!audit.ok)throw new Error(audit.errors.join(' / '));
      const c=counts(payload);
      global.showToast?.(`무결성 정상 · 개념 ${c.concepts} · 활성 연결 ${c.activeLinks} · 고아 연결 ${c.orphanedLinks}`);
      updateStatusUI(meta());
    }
    if(action==='save-config'){
      const c=cfg();
      c.url=(document.getElementById('sbUrl')?.value||'').trim().replace(/\/+$/,'');
      c.anonKey=(document.getElementById('sbAnonKey')?.value||'').trim();
      c.syncKey=(document.getElementById('sbSyncKey')?.value||'').trim();
      c.deviceAlias=(document.getElementById('sbDeviceAlias')?.value||'').trim().slice(0,80);
      c.auto=false;
      c.autoPull=false;
      localStorage.setItem(APP_KEY,JSON.stringify(global.__ipeGetAppState?.()||{}));
      startupState='pending';
      setMeta({serverState:enabled()?'checking':'unconfigured',startupChecked:false,lastError:''});
      await startupCheck();
      global.showToast?.('연결 정보를 이 브라우저에 저장하고 서버 상태를 확인했어.');
    }
    if(action==='copy-sql'){
      const sql=await (await fetch('supabase-normalized-v2.sql')).text();
      await navigator.clipboard.writeText(sql);
      global.showToast?.('최신 저장소 SQL을 복사했어.');
    }
  }
  function install(){
    if(installed)return;
    installed=true;
    kernelReady=initializeKernel().catch(error=>{
      setMeta({localState:'failed',lastError:'저장 커널 초기화 실패: '+error.message});
      throw error;
    });
    const currentCfg=cfg();
    if(currentCfg){currentCfg.auto=false;currentCfg.autoPull=false}
    global.v14TryStartupPull=function(){};
    global.cloudUploadNow=()=>flushNow('manual-or-auto',{manual:true});
    global.cloudDownloadNow=()=>pull();
    global.exportData=()=>createBackup();
    global.importData=file=>importFile(file);

    const baseSettings=global.renderSettings;
    global.renderSettings=function(){return stripLegacySettings(baseSettings())+panel()};
    const baseSave=global.save;
    global.save=function(message){
      const result=baseSave(message);
      markChanged(`app-data-change:${message||'change'}`,700);
      return result;
    };

    window.addEventListener('message',event=>{
      const data=event.data||{};
      if(data.type==='ipe-atlas-saved'){
        const frames=typeof global.v17ActiveAtlasFrames==='function'?global.v17ActiveAtlasFrames():[];
        if(frames.length&&!frames.some(frame=>frame.contentWindow===event.source))return;
        const guard=global.__ipeNormalizedImportGuard;
        if(importInProgress||(guard&&Date.now()<guard.until))return;
        if(!data.parentHandled)markChanged('atlas-data-change',800);
      }
      if(data.type==='ipe-atlas-bridge-updated')markChanged('bridge-data-change',550);
    },false);
    document.addEventListener('click',async event=>{
      const button=event.target.closest('[data-sync-action]');
      if(!button)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      button.disabled=true;
      try{await handleAction(button.dataset.syncAction,button)}
      catch(error){setMeta({lastError:error.message});global.showToast?.(error.message)}
      finally{button.disabled=false}
    },true);
    document.addEventListener('change',async event=>{
      if(event.target.id!=='syncImportFile'||!event.target.files?.[0])return;
      try{await importFile(event.target.files[0])}
      catch(error){setMeta({lastError:error.message});global.showToast?.('백업 적용 실패: '+error.message)}
      finally{event.target.value=''}
    },true);
    window.addEventListener('online',()=>{
      startupState='pending';
      startupCheck().catch(()=>{});
    });
    window.addEventListener('offline',()=>setMeta({serverState:meta().dirty?'offline':meta().serverState}));
    window.addEventListener('keydown',event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){
        event.preventDefault();
        handleAction('save').catch(error=>global.showToast?.(error.message));
      }
    });
    kernel?.subscribe(event=>{
      if(!event.remote)return;
      if(event.type==='snapshot-written'){
        setMeta({dirty:true,serverState:enabled()?'queued':'unconfigured'});
      }
      if(event.type==='server-acked')startupCheck().catch(()=>{});
    });
    updateStatusUI(meta());
    setTimeout(()=>startupCheck().catch(()=>{}),250);
  }

  global.IpeNormalizedSync={
    install,
    flushNow,
    commit:flushNow,
    pull,
    history,
    loadHistory,
    saveNamedHistory,
    resolveConflictKeepLocal,
    schedule:markChanged,
    validate,
    localPayload,
    collectPayload,
    createBackup,
    importFile,
    importAtlasFile,
    meta,
    counts,
    startupCheck,
    acceptAtlasSnapshot,
  };
})(window);
