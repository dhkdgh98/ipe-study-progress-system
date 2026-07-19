(function(global){
  'use strict';

  const DB_NAME='ipe-atlas-runtime';
  const DB_VERSION=1;
  const STORE='snapshots';
  const SCHEMA_VERSION=2;

  function idle(fn,timeout=1200){
    if(typeof requestIdleCallback==='function')return requestIdleCallback(fn,{timeout});
    return setTimeout(fn,0);
  }

  function openDatabase(){
    if(!global.indexedDB)return Promise.resolve(null);
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'key'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
  }

  function validateState(state){
    const errors=[];
    const concepts=Array.isArray(state?.concepts)?state.concepts:[];
    const frames=Array.isArray(state?.frames)?state.frames:[];
    const ids=new Set();
    for(const concept of concepts){
      if(!concept?.id)errors.push('concept_without_id');
      else if(ids.has(concept.id))errors.push(`duplicate_concept:${concept.id}`);
      else ids.add(concept.id);
    }
    for(const concept of concepts){
      for(const parent of concept.parents||[])if(!ids.has(parent))errors.push(`missing_parent:${concept.id}:${parent}`);
      for(const related of concept.related||[])if(!ids.has(related))errors.push(`missing_related:${concept.id}:${related}`);
    }
    for(const frame of frames){
      if(frame.anchorId&&!ids.has(frame.anchorId))errors.push(`missing_anchor:${frame.id}:${frame.anchorId}`);
      for(const member of frame.members||[])if(!ids.has(member))errors.push(`missing_member:${frame.id}:${member}`);
    }
    return {ok:errors.length===0,errors:errors.slice(0,200),counts:{concepts:concepts.length,frames:frames.length,keywords:(state?.keywords||[]).length}};
  }

  function migrateSnapshot(input){
    const source=input&&typeof input==='object'?input:{};
    const state=source.state&&source.schemaVersion?source.state:source;
    const cloned=typeof structuredClone==='function'?structuredClone(state):JSON.parse(JSON.stringify(state));
    const report=validateState(cloned);
    return {schemaVersion:SCHEMA_VERSION,migratedAt:new Date().toISOString(),state:cloned,report};
  }

  function createAtlasPerformanceRuntime(api){
    let currentState=null;
    let conceptById=new Map(),frameById=new Map(),childrenByParent=new Map(),framesByAnchor=new Map(),bridgeByConcept=new Map();
    let keywordList=[],saveTimer=0,feedScrollBound=false,navScrollBound=false;
    const metrics={rebuilds:0,lastBuildMs:0,lastPersistMs:0};

    function rebuild(force=false){
      const state=api.getState();
      if(!force&&state===currentState&&conceptById.size===state.concepts.length&&frameById.size===state.frames.length)return;
      const started=performance.now();
      currentState=state;
      conceptById=new Map((state.concepts||[]).map(c=>[c.id,c]));
      frameById=new Map((state.frames||[]).map(f=>[f.id,f]));
      childrenByParent=new Map();framesByAnchor=new Map();bridgeByConcept=new Map();
      for(const concept of state.concepts||[]){
        const parent=concept.primaryParent||concept.parents?.[0]||'';
        if(parent){if(!childrenByParent.has(parent))childrenByParent.set(parent,[]);childrenByParent.get(parent).push(concept)}
      }
      for(const frame of state.frames||[]){
        if(!framesByAnchor.has(frame.anchorId))framesByAnchor.set(frame.anchorId,[]);
        framesByAnchor.get(frame.anchorId).push(frame);
      }
      for(const link of api.getBridgeLinks?.()||[]){
        if(!bridgeByConcept.has(link.conceptId))bridgeByConcept.set(link.conceptId,[]);
        bridgeByConcept.get(link.conceptId).push(link);
      }
      const words=new Set(state.keywords||[]);
      for(const concept of state.concepts||[])for(const [key] of api.sections)for(const line of concept.sections?.[key]||[])for(const word of line.keywords||[])if(word)words.add(word);
      keywordList=[...words];
      metrics.rebuilds++;metrics.lastBuildMs=performance.now()-started;
    }

    function invalidate(){currentState=null}
    function getConcept(id){rebuild();return conceptById.get(id)}
    function getFrame(id){rebuild();return frameById.get(id)}
    function getChildren(id){rebuild();return childrenByParent.get(id)||[]}
    function getFrames(id){rebuild();return framesByAnchor.get(id)||[]}
    function getBridge(id){rebuild();return bridgeByConcept.get(id)||[]}
    function getKeywords(){rebuild();return keywordList}

    async function persistNow(){
      const started=performance.now();
      const state=api.getState();
      const migrated=migrateSnapshot(state);
      if(!migrated.report.ok){console.warn('[Atlas] IndexedDB mirror skipped: validation failed',migrated.report);return migrated.report}
      try{
        const db=await openDatabase();
        if(!db)return migrated.report;
        await new Promise((resolve,reject)=>{
          const tx=db.transaction(STORE,'readwrite');
          tx.objectStore(STORE).put({key:'current',...migrated});
          tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
        });
        metrics.lastPersistMs=performance.now()-started;
      }catch(error){console.warn('[Atlas] IndexedDB mirror failed; localStorage remains authoritative',error)}
      return migrated.report;
    }
    function schedulePersist(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>idle(persistNow),450)}

    function sliceWindow(root,count,rowHeight,overscan=10){
      const height=Math.max(root?.clientHeight||640,300);
      const start=Math.max(0,Math.floor((root?.scrollTop||0)/rowHeight)-overscan);
      const size=Math.ceil(height/rowHeight)+overscan*2;
      return {start,end:Math.min(count,start+size),top:start*rowHeight,bottom:Math.max(0,(count-Math.min(count,start+size))*rowHeight)};
    }

    function renderFeed(){
      const root=api.query('#feed'),inner=api.query('#feedInner');if(!root||!inner)return;
      const state=api.getState(),filter=api.getUi().filter;
      const records=filter==='definition'?state.concepts.map(value=>({kind:'concept',value})):
        filter==='all'?[...state.concepts.map(value=>({kind:'concept',value})),...state.frames.map(value=>({kind:'frame',value}))]:
        state.frames.filter(f=>f.type===filter).map(value=>({kind:'frame',value}));
      const win=sliceWindow(root,records.length,filter==='definition'?250:290,6);
      const html=records.slice(win.start,win.end).map(record=>record.kind==='concept'?api.conceptCard(record.value):api.frameCard(record.value)).join('');
      inner.innerHTML=api.feedHeader()+`<div data-virtual-feed style="padding-top:${win.top}px;padding-bottom:${win.bottom}px">${html}</div>`;
      api.initLazyGraphs();
      if(!feedScrollBound){feedScrollBound=true;let raf=0;root.addEventListener('scroll',()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;renderFeed()})},{passive:true})}
    }

    function renderNav(){
      const root=api.query('#navList');if(!root)return;
      const state=api.getState(),ui=api.getUi(),q=(api.query('#searchInput')?.value||'').trim().toLowerCase();
      let records=ui.filter==='definition'||ui.filter==='all'||ui.filter==='related'?state.concepts:state.frames.filter(f=>f.type===ui.filter);
      if(q)records=records.filter(x=>`${x.title||''} ${x.domain||''} ${x.definition||''}`.toLowerCase().includes(q));
      const win=sliceWindow(root,records.length,42,12);
      const concept=ui.filter==='definition'||ui.filter==='all'||ui.filter==='related';
      const html=records.slice(win.start,win.end).map(item=>concept?
        `<button class="nav-main ${ui.selected.kind==='concept'&&ui.selected.id===item.id?'active':''}" data-open-concept="${api.escape(item.id)}"><span class="dot"></span><span class="nav-name">${api.escape(item.title)}</span><span class="nav-meta">${api.escape(item.domain||'')}</span></button>`:
        `<button class="frame-row ${ui.selected.kind==='frame'&&ui.selected.id===item.id?'active':''}" data-open-frame="${api.escape(item.id)}"><span class="frame-icon">◇</span><span class="nav-name">${api.escape(item.title)}</span></button>`).join('');
      root.innerHTML=`<div style="padding-top:${win.top}px;padding-bottom:${win.bottom}px">${html||'<div class="hint" style="padding:12px">표시할 항목이 없어.</div>'}</div>`;
      const title=ui.filter==='all'?'전체 탐색기':ui.filter==='definition'?'정의 탐색기':'관계 탐색기';
      const titleEl=api.query('#navTitle'),hintEl=api.query('#navHint'),countEl=api.query('#navCount');
      if(titleEl)titleEl.textContent=title;if(hintEl)hintEl.textContent='대용량 데이터용 가상 목록 · 스크롤한 항목만 렌더링';if(countEl)countEl.textContent=records.length+'개';
      if(!navScrollBound){navScrollBound=true;let raf=0;root.addEventListener('scroll',()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;renderNav()})},{passive:true})}
    }

    rebuild(true);schedulePersist();
    return {rebuild,invalidate,conceptById:getConcept,frameById:getFrame,children:getChildren,framesFor:getFrames,bridgeLinksFor:getBridge,allKeywords:getKeywords,schedulePersist,persistNow,renderFeed,renderNav,validate:()=>validateState(api.getState()),migrateSnapshot,metrics};
  }

  global.createAtlasPerformanceRuntime=createAtlasPerformanceRuntime;
  global.AtlasPerformanceMigration={SCHEMA_VERSION,validateState,migrateSnapshot};
})(typeof window!=='undefined'?window:globalThis);
