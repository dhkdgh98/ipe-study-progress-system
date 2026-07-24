(function(global){
  'use strict';

  const DB_NAME='ipe-learning-os-kernel';
  const DB_VERSION=1;
  const FALLBACK_KEY='ipe-persistence-kernel-fallback-v1';
  const SNAPSHOT_KEY='working';
  const CHANNEL_NAME='ipe-persistence-kernel-v1';
  const LEGACY_MIGRATION_KEY='migration:legacy-v1';
  const instanceId=makeId();
  const listeners=new Set();
  let dbPromise=null;
  let snapshotCache=null;
  let configured={};
  let initialized=null;
  let channel=null;
  let fallbackCache=null;

  function makeId(){
    const source=global.crypto;
    if(source?.randomUUID)return source.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,char=>{
      const random=Math.random()*16|0;
      return (char==='x'?random:(random&3|8)).toString(16);
    });
  }
  function iso(){return new Date().toISOString()}
  function clone(value){
    if(value===undefined)return undefined;
    if(typeof global.structuredClone==='function')return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function stable(value){
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(value&&typeof value==='object'){
      return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
    }
    return JSON.stringify(value);
  }
  async function defaultHash(value){
    const text=typeof value==='string'?value:stable(value);
    if(global.crypto?.subtle&&global.TextEncoder){
      const digest=await global.crypto.subtle.digest('SHA-256',new global.TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    let hash=2166136261;
    for(let index=0;index<text.length;index++){
      hash^=text.charCodeAt(index);
      hash=Math.imul(hash,16777619);
    }
    return 'fallback-'+(hash>>>0).toString(16).padStart(8,'0');
  }
  function hashPayload(payload){return (configured.hash||defaultHash)(payload)}
  function countPayload(payload){
    return configured.counts?configured.counts(payload):{
      progress:Object.keys(payload?.app?.progress||{}).length,
      notes:Object.keys(payload?.app?.notes||{}).length,
      concepts:Array.isArray(payload?.atlas?.concepts)?payload.atlas.concepts.length:0,
      frames:Array.isArray(payload?.atlas?.frames)?payload.atlas.frames.length:0,
      objects:Array.isArray(payload?.atlas?.objects)?payload.atlas.objects.length:0,
      activeLinks:Array.isArray(payload?.bridge?.links)?payload.bridge.links.length:0,
      orphanedLinks:Array.isArray(payload?.bridge?.orphanedLinks)?payload.bridge.orphanedLinks.length:0,
    };
  }
  function assertValid(payload){
    if(!payload?.app||!payload?.atlas||!payload?.bridge)throw new Error('통합 저장 데이터에 App·Atlas·Bridge가 모두 필요함');
    const audit=configured.validate?.(payload);
    if(audit&&!audit.ok)throw new Error('통합 저장 무결성 오류: '+audit.errors.join(' / '));
    return audit||{ok:true};
  }
  function sameCounts(left,right){
    const leftKeys=Object.keys(left||{}),rightKeys=Object.keys(right||{});
    if(leftKeys.length!==rightKeys.length)return false;
    return leftKeys.every(key=>Number(left[key])===Number(right[key]));
  }

  function requestResult(request){
    return new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('IndexedDB request failed'));
    });
  }
  function transactionDone(transaction){
    return new Promise((resolve,reject)=>{
      transaction.oncomplete=()=>resolve();
      transaction.onabort=()=>reject(transaction.error||new Error('IndexedDB transaction aborted'));
      transaction.onerror=()=>reject(transaction.error||new Error('IndexedDB transaction failed'));
    });
  }
  function openDatabase(){
    if(!global.indexedDB)return Promise.resolve(null);
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=global.indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('snapshots'))db.createObjectStore('snapshots',{keyPath:'key'});
        if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'});
        if(!db.objectStoreNames.contains('checkpoints'))db.createObjectStore('checkpoints',{keyPath:'id'});
        if(!db.objectStoreNames.contains('outbox')){
          const outbox=db.createObjectStore('outbox',{keyPath:'operationId'});
          outbox.createIndex('workspaceKey','workspaceKey',{unique:false});
          outbox.createIndex('status','status',{unique:false});
          outbox.createIndex('createdAt','createdAt',{unique:false});
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('IndexedDB open failed'));
      request.onblocked=()=>reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
    return dbPromise;
  }
  async function idbTransaction(storeNames,mode,callback){
    const db=await openDatabase();
    if(!db)return null;
    const transaction=db.transaction(storeNames,mode);
    const completion=transactionDone(transaction);
    let result;
    try{
      result=await callback(transaction);
      await completion;
      return result;
    }catch(error){
      try{transaction.abort()}catch{}
      throw error;
    }
  }

  function emptyFallback(){return {snapshots:{},meta:{},checkpoints:{},outbox:{}}}
  function fallbackState(){
    if(fallbackCache)return fallbackCache;
    try{
      fallbackCache=JSON.parse(global.localStorage?.getItem(FALLBACK_KEY)||'null')||emptyFallback();
    }catch{
      fallbackCache=emptyFallback();
    }
    for(const key of ['snapshots','meta','checkpoints','outbox'])fallbackCache[key]||={};
    return fallbackCache;
  }
  function saveFallback(){
    try{global.localStorage?.setItem(FALLBACK_KEY,JSON.stringify(fallbackState()))}catch{}
  }
  async function getRecord(store,key){
    const db=await openDatabase();
    if(!db)return clone(fallbackState()[store][key]||null);
    return idbTransaction([store],'readonly',transaction=>requestResult(transaction.objectStore(store).get(key)));
  }
  async function putRecord(store,record){
    const db=await openDatabase();
    if(!db){
      fallbackState()[store][record.key||record.id||record.operationId]=clone(record);
      saveFallback();
      return clone(record);
    }
    await idbTransaction([store],'readwrite',transaction=>requestResult(transaction.objectStore(store).put(record)));
    return clone(record);
  }
  async function deleteRecord(store,key){
    const db=await openDatabase();
    if(!db){
      delete fallbackState()[store][key];
      saveFallback();
      return;
    }
    await idbTransaction([store],'readwrite',transaction=>requestResult(transaction.objectStore(store).delete(key)));
  }
  async function allRecords(store){
    const db=await openDatabase();
    if(!db)return Object.values(fallbackState()[store]).map(clone);
    return idbTransaction([store],'readonly',transaction=>requestResult(transaction.objectStore(store).getAll()));
  }

  function emit(type,detail={}){
    const event={type,instanceId,at:iso(),...detail};
    for(const listener of listeners){
      try{listener(event)}catch{}
    }
    try{channel?.postMessage(event)}catch{}
    return event;
  }
  function setupChannel(){
    if(channel||!global.BroadcastChannel)return;
    try{
      channel=new global.BroadcastChannel(CHANNEL_NAME);
      channel.onmessage=event=>{
        const message=event.data||{};
        if(message.instanceId===instanceId)return;
        for(const listener of listeners){
          try{listener({...message,remote:true})}catch{}
        }
      };
    }catch{}
  }

  async function readSnapshot(){
    const record=await getRecord('snapshots',SNAPSHOT_KEY);
    snapshotCache=record||null;
    return clone(record);
  }
  function peekSnapshot(){return clone(snapshotCache)}
  async function readMeta(key){return clone((await getRecord('meta',key))?.value||null)}
  async function writeMeta(key,value){
    const record={key,value:clone(value),updatedAt:iso()};
    await putRecord('meta',record);
    return clone(value);
  }
  async function patchMeta(key,patch){
    const current=await readMeta(key)||{};
    const next={...current,...clone(patch)};
    await writeMeta(key,next);
    return next;
  }
  async function checkpoint(payload,{source='checkpoint',metadata={}}={}){
    assertValid(payload);
    const record={
      id:makeId(),
      source,
      createdAt:iso(),
      payloadHash:await hashPayload(payload),
      counts:countPayload(payload),
      payload:clone(payload),
      metadata:clone(metadata),
    };
    await putRecord('checkpoints',record);
    return clone(record);
  }
  async function listCheckpoints(limit=20){
    const rows=await allRecords('checkpoints');
    return rows.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,limit).map(clone);
  }

  function buildOperation(snapshot,remote,reason){
    return {
      operationId:makeId(),
      workspaceKey:remote.workspaceKey,
      syncId:remote.syncId,
      writeHash:remote.writeHash,
      expectedRevision:Number(remote.expectedRevision)||0,
      deviceId:remote.deviceId||instanceId,
      payloadHash:snapshot.payloadHash,
      payload:clone(snapshot.payload),
      generation:snapshot.generation,
      reason,
      status:'pending',
      attemptCount:0,
      createdAt:iso(),
      updatedAt:iso(),
      lastAttemptAt:'',
      nextAttemptAt:'',
      lastError:'',
    };
  }
  function canCoalesce(operation,remote){
    return operation&&operation.workspaceKey===remote.workspaceKey&&
      operation.syncId===remote.syncId&&operation.status==='pending'&&
      Number(operation.attemptCount||0)===0&&!operation.lastAttemptAt;
  }
  async function writeSnapshot(payload,{reason='data-change',remote=null,enqueue=!!remote,source='runtime'}={}){
    const audit=assertValid(payload);
    const payloadHash=await hashPayload(payload);
    const createdAt=iso();
    const db=await openDatabase();
    let output;
    if(!db){
      const state=fallbackState();
      const previous=state.snapshots[SNAPSHOT_KEY]||null;
      const snapshot={
        key:SNAPSHOT_KEY,
        schemaVersion:1,
        generation:Number(previous?.generation||0)+1,
        payloadHash,
        counts:countPayload(payload),
        payload:clone(payload),
        source,
        reason,
        updatedAt:createdAt,
      };
      let operation=null;
      if(enqueue&&remote){
        operation=Object.values(state.outbox).find(item=>canCoalesce(item,remote))||null;
        if(operation){
          operation={...operation,payloadHash,payload:clone(payload),generation:snapshot.generation,reason,updatedAt:createdAt};
        }else operation=buildOperation(snapshot,remote,reason);
        state.outbox[operation.operationId]=operation;
      }
      state.snapshots[SNAPSHOT_KEY]=snapshot;
      saveFallback();
      output={snapshot,operation,audit};
    }else{
      output=await idbTransaction(['snapshots','outbox'],'readwrite',async transaction=>{
        const snapshots=transaction.objectStore('snapshots');
        const outbox=transaction.objectStore('outbox');
        const previous=await requestResult(snapshots.get(SNAPSHOT_KEY));
        const snapshot={
          key:SNAPSHOT_KEY,
          schemaVersion:1,
          generation:Number(previous?.generation||0)+1,
          payloadHash,
          counts:countPayload(payload),
          payload:clone(payload),
          source,
          reason,
          updatedAt:createdAt,
        };
        let operation=null;
        if(enqueue&&remote){
          const pending=await requestResult(outbox.getAll());
          operation=pending.find(item=>canCoalesce(item,remote))||null;
          if(operation){
            operation={...operation,payloadHash,payload:clone(payload),generation:snapshot.generation,reason,updatedAt:createdAt};
          }else operation=buildOperation(snapshot,remote,reason);
          await requestResult(outbox.put(operation));
        }
        await requestResult(snapshots.put(snapshot));
        return {snapshot,operation,audit};
      });
    }
    snapshotCache=clone(output.snapshot);
    emit('snapshot-written',{
      generation:output.snapshot.generation,
      payloadHash,
      operationId:output.operation?.operationId||null,
      workspaceKey:remote?.workspaceKey||null,
      reason,
    });
    return clone(output);
  }
  async function ensureOutbox(remote,{reason='sync-queue'}={}){
    const snapshot=await readSnapshot();
    if(!snapshot)throw new Error('서버 큐에 넣을 로컬 스냅샷이 없음');
    const operations=await allRecords('outbox');
    const current=operations.find(item=>
      item.workspaceKey===remote.workspaceKey&&item.payloadHash===snapshot.payloadHash&&
      ['pending','sending'].includes(item.status)
    );
    if(current)return current;
    const operation=buildOperation(snapshot,remote,reason);
    await putRecord('outbox',operation);
    emit('outbox-queued',{workspaceKey:remote.workspaceKey,operationId:operation.operationId});
    return operation;
  }
  async function listOutbox(workspaceKey=null){
    const rows=await allRecords('outbox');
    return rows.filter(row=>!workspaceKey||row.workspaceKey===workspaceKey)
      .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(clone);
  }
  async function claimNext(workspaceKey){
    const createdAt=Date.now();
    const db=await openDatabase();
    if(!db){
      const candidate=Object.values(fallbackState().outbox)
        .filter(item=>item.workspaceKey===workspaceKey&&item.status==='pending'&&(!item.nextAttemptAt||Date.parse(item.nextAttemptAt)<=createdAt))
        .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))[0]||null;
      if(!candidate)return null;
      const claimed={...candidate,status:'sending',attemptCount:Number(candidate.attemptCount||0)+1,lastAttemptAt:iso(),updatedAt:iso()};
      fallbackState().outbox[claimed.operationId]=claimed;
      saveFallback();
      return clone(claimed);
    }
    return idbTransaction(['outbox'],'readwrite',async transaction=>{
      const store=transaction.objectStore('outbox');
      const candidates=(await requestResult(store.getAll()))
        .filter(item=>item.workspaceKey===workspaceKey&&item.status==='pending'&&(!item.nextAttemptAt||Date.parse(item.nextAttemptAt)<=createdAt))
        .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
      if(!candidates.length)return null;
      const claimed={...candidates[0],status:'sending',attemptCount:Number(candidates[0].attemptCount||0)+1,lastAttemptAt:iso(),updatedAt:iso()};
      await requestResult(store.put(claimed));
      return claimed;
    });
  }
  async function patchOperation(operationId,patch){
    const current=(await getRecord('outbox',operationId));
    if(!current)return null;
    const next={...current,...clone(patch),updatedAt:iso()};
    await putRecord('outbox',next);
    emit('outbox-updated',{workspaceKey:next.workspaceKey,operationId,status:next.status});
    return next;
  }
  async function markFailed(operationId,error,{delayMs=0,conflict=false}={}){
    return patchOperation(operationId,{
      status:conflict?'conflict':'pending',
      lastError:String(error?.message||error||'unknown error'),
      nextAttemptAt:conflict?'':new Date(Date.now()+Math.max(0,delayMs)).toISOString(),
    });
  }
  async function markAcked(operationId,{revision,committedAt,payloadHash}={}){
    const operation=await patchOperation(operationId,{
      status:'acked',
      revision:Number(revision)||0,
      committedAt:committedAt||iso(),
      acknowledgedHash:payloadHash||'',
      lastError:'',
      nextAttemptAt:'',
    });
    if(operation){
      await pruneAcked(operation.workspaceKey);
      emit('server-acked',{workspaceKey:operation.workspaceKey,operationId,revision:Number(revision)||0});
    }
    return operation;
  }
  async function pruneAcked(workspaceKey,keep=25){
    const rows=await listOutbox(workspaceKey);
    const expired=rows.filter(row=>row.status==='acked')
      .sort((a,b)=>String(b.committedAt||b.updatedAt).localeCompare(String(a.committedAt||a.updatedAt)))
      .slice(keep);
    for(const row of expired)await deleteRecord('outbox',row.operationId);
    return expired.length;
  }
  async function rebasePending(workspaceKey,expectedRevision){
    const rows=await listOutbox(workspaceKey);
    const targets=rows.filter(row=>row.status==='pending'&&Number(row.attemptCount||0)===0);
    for(const row of targets)await patchOperation(row.operationId,{expectedRevision:Number(expectedRevision)||0});
    return targets.length;
  }
  async function releaseInterrupted(workspaceKey=null){
    const rows=await listOutbox(workspaceKey);
    const targets=rows.filter(row=>row.status==='sending');
    for(const row of targets)await patchOperation(row.operationId,{status:'pending',lastError:'이전 실행이 커밋 응답 전에 종료됨',nextAttemptAt:''});
    return targets.length;
  }
  async function pendingCount(workspaceKey=null){
    const rows=await listOutbox(workspaceKey);
    return rows.filter(row=>['pending','sending','conflict'].includes(row.status)).length;
  }
  async function supersedeOpen(workspaceKey,reason='superseded'){
    const rows=await listOutbox(workspaceKey);
    const targets=rows.filter(row=>['pending','sending','conflict'].includes(row.status));
    for(const row of targets)await patchOperation(row.operationId,{status:'superseded',supersededReason:reason,nextAttemptAt:''});
    return targets.length;
  }

  async function migrateLegacy(){
    const existing=await readSnapshot();
    if(existing)return {migrated:false,snapshot:existing,reason:'already-initialized'};
    const prior=await readMeta(LEGACY_MIGRATION_KEY);
    if(prior?.status==='complete'){
      throw new Error('마이그레이션 완료 표시는 있으나 통합 스냅샷을 읽을 수 없음');
    }
    if(typeof configured.legacyReader!=='function')return {migrated:false,snapshot:null,reason:'no-legacy-reader'};
    const payload=await configured.legacyReader();
    if(!payload)return {migrated:false,snapshot:null,reason:'no-legacy-data'};
    const audit=assertValid(payload);
    const expectedHash=await hashPayload(payload);
    const expectedCounts=countPayload(payload);
    await writeMeta(LEGACY_MIGRATION_KEY,{status:'copying',startedAt:iso(),expectedHash,expectedCounts});
    const written=await writeSnapshot(payload,{reason:'legacy-migration',enqueue:false,source:'legacy-localStorage'});
    const verified=await readSnapshot();
    if(!verified||verified.payloadHash!==expectedHash||!sameCounts(verified.counts,expectedCounts)){
      await writeMeta(LEGACY_MIGRATION_KEY,{status:'failed',failedAt:iso(),expectedHash,expectedCounts});
      throw new Error('기존 데이터 복사 후 해시·개수 재검증 실패');
    }
    await writeMeta(LEGACY_MIGRATION_KEY,{
      status:'complete',
      completedAt:iso(),
      expectedHash,
      expectedCounts,
      legacyKeysRetained:true,
    });
    emit('migration-complete',{payloadHash:expectedHash,counts:expectedCounts});
    return {migrated:true,snapshot:written.snapshot,audit};
  }
  async function initialize(options={}){
    configured={...configured,...options};
    setupChannel();
    if(initialized)return initialized;
    initialized=(async()=>{
      await openDatabase();
      await releaseInterrupted();
      return migrateLegacy();
    })().catch(error=>{
      initialized=null;
      throw error;
    });
    return initialized;
  }

  async function fallbackLease(workspaceKey,task){
    const storage=global.localStorage;
    if(!storage)return {acquired:true,value:await task()};
    const leaseKey='ipe-persistence-writer-lease:'+workspaceKey;
    const nowMs=Date.now();
    let current=null;
    try{current=JSON.parse(storage.getItem(leaseKey)||'null')}catch{}
    if(current&&current.owner!==instanceId&&Number(current.expiresAt)>nowMs)return {acquired:false};
    const mine={owner:instanceId,expiresAt:nowMs+30000};
    try{
      storage.setItem(leaseKey,JSON.stringify(mine));
      const verified=JSON.parse(storage.getItem(leaseKey)||'null');
      if(verified?.owner!==instanceId)return {acquired:false};
    }catch{
      return {acquired:true,value:await task()};
    }
    let renewal=0;
    if(global.setInterval){
      renewal=global.setInterval(()=>{
        try{
          const latest=JSON.parse(storage.getItem(leaseKey)||'null');
          if(latest?.owner===instanceId){
            storage.setItem(leaseKey,JSON.stringify({owner:instanceId,expiresAt:Date.now()+30000}));
          }
        }catch{}
      },10000);
    }
    try{return {acquired:true,value:await task()}}
    finally{
      if(renewal&&global.clearInterval)global.clearInterval(renewal);
      try{
        const latest=JSON.parse(storage.getItem(leaseKey)||'null');
        if(latest?.owner===instanceId)storage.removeItem(leaseKey);
      }catch{}
    }
  }
  async function withWriterLock(workspaceKey,task){
    const name='ipe-persistence-writer:'+workspaceKey;
    if(global.navigator?.locks?.request){
      let acquired=false;
      const value=await global.navigator.locks.request(name,{ifAvailable:true},async lock=>{
        if(!lock)return undefined;
        acquired=true;
        return task();
      });
      return {acquired,value};
    }
    return fallbackLease(workspaceKey,task);
  }

  function subscribe(listener){
    listeners.add(listener);
    return ()=>listeners.delete(listener);
  }
  function configure(options={}){configured={...configured,...options};return api}
  function diagnostics(){
    return {
      dbName:DB_NAME,
      dbVersion:DB_VERSION,
      instanceId,
      indexedDB:!!global.indexedDB,
      broadcastChannel:!!global.BroadcastChannel,
      webLocks:!!global.navigator?.locks?.request,
      snapshot:peekSnapshot(),
    };
  }

  const api={
    DB_NAME,
    DB_VERSION,
    instanceId,
    configure,
    initialize,
    readSnapshot,
    peekSnapshot,
    writeSnapshot,
    checkpoint,
    listCheckpoints,
    readMeta,
    writeMeta,
    patchMeta,
    ensureOutbox,
    listOutbox,
    claimNext,
    markFailed,
    markAcked,
    rebasePending,
    releaseInterrupted,
    pendingCount,
    supersedeOpen,
    withWriterLock,
    subscribe,
    diagnostics,
    stable,
    hash:defaultHash,
  };
  global.IpePersistenceKernel=api;
})(window);
