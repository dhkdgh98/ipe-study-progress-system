import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const kernelSource=fs.readFileSync(new URL('../persistence-kernel.js',import.meta.url),'utf8');
const syncSource=fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8');
const storage=new Map();
const localStorage={
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key),
};
const initialApp={version:4,activeTab:'dashboard',progress:{},notes:{},settings:{}};
const initialAtlas={concepts:[{id:'c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const initialBridge={links:[{itemId:'001',conceptId:'c1'}],orphanedLinks:[],catalog:[]};
storage.set('ipe-learning-os-v4',JSON.stringify(initialApp));
storage.set('concept-atlas-v3-feed',JSON.stringify(initialAtlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(initialBridge));

async function loadRuntime(){
  let liveApp=JSON.parse(storage.get('ipe-learning-os-v4'));
  const document={addEventListener(){},getElementById(){return null}};
  const window={
    crypto:webcrypto,
    TextEncoder,
    localStorage,
    structuredClone,
    navigator:{onLine:true},
    addEventListener(){},
    cloudCfg:()=>null,
    renderSettings:()=>'',
    save:()=>{},
    __ipeGetAppState:()=>liveApp,
    v17StorageGet:key=>JSON.parse(localStorage.getItem(key)||'null'),
    bridge:()=>JSON.parse(localStorage.getItem('ipe-atlas-bridge-v1')),
    v17FlushAllStores:async()=>({
      app:liveApp,
      atlas:JSON.parse(localStorage.getItem('concept-atlas-v3-feed')),
      bridge:JSON.parse(localStorage.getItem('ipe-atlas-bridge-v1')),
    }),
    applySnapshotPayload:data=>{
      liveApp={...liveApp,...data.app};
      localStorage.setItem('ipe-learning-os-v4',JSON.stringify(liveApp));
      localStorage.setItem('concept-atlas-v3-feed',JSON.stringify(data.atlas));
      localStorage.setItem('ipe-atlas-bridge-v1',JSON.stringify(data.bridge));
    },
  };
  const context={
    window,
    document,
    crypto:webcrypto,
    TextEncoder,
    localStorage,
    navigator:window.navigator,
    console,
    setTimeout,
    clearTimeout,
    confirm:()=>false,
    Blob,
    URL,
    Date,
    Math,
    JSON,
    Uint8Array,
  };
  vm.runInNewContext(kernelSource,context);
  vm.runInNewContext(syncSource,context);
  window.IpeNormalizedSync.install();
  await new Promise(resolve=>setTimeout(resolve,80));
  return {window,getLiveApp:()=>liveApp};
}

const first=await loadRuntime();
assert.equal((await first.window.IpePersistenceKernel.readSnapshot()).payload.atlas.concepts[0].id,'c1');

const crashApp={...initialApp,notes:{'001':'written-before-crash'}};
const crashAtlas={concepts:[{id:'crash-c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const crashBridge={links:[{itemId:'001',conceptId:'crash-c1'}],orphanedLinks:[],catalog:[]};
storage.set('ipe-learning-os-v4',JSON.stringify(crashApp));
storage.set('concept-atlas-v3-feed',JSON.stringify(crashAtlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(crashBridge));
storage.set('ipe-persistence-legacy-dirty-v1',JSON.stringify({source:'test'}));

const second=await loadRuntime();
const recovered=await second.window.IpePersistenceKernel.readSnapshot();
assert.equal(recovered.payload.app.notes['001'],'written-before-crash','a write-ahead legacy marker must recover a pre-IDB browser exit');
assert.equal(recovered.payload.atlas.concepts[0].id,'crash-c1');
assert.equal(localStorage.getItem('ipe-persistence-legacy-dirty-v1'),null,'the marker may clear only after read-back verification');
assert.equal((await second.window.IpePersistenceKernel.listCheckpoints())[0].source,'pre-crash-recovery');

const idbAhead=structuredClone(recovered.payload);
idbAhead.app.notes['001']='idb-before-mirror';
idbAhead.atlas.concepts[0].title='canonical';
await second.window.IpePersistenceKernel.writeSnapshot(idbAhead,{reason:'idb-ahead',enqueue:false});
assert.equal(JSON.parse(storage.get('ipe-learning-os-v4')).notes['001'],'written-before-crash');

const third=await loadRuntime();
assert.equal(third.getLiveApp().notes['001'],'idb-before-mirror','the verified canonical snapshot must repair a stale compatibility mirror');
assert.equal(JSON.parse(storage.get('concept-atlas-v3-feed')).concepts[0].title,'canonical');

console.log('normalized crash recovery: ok');
