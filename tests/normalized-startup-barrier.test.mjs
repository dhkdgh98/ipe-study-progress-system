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
const localApp={version:4,progress:{},notes:{'001':'old'},settings:{}};
const localAtlas={concepts:[{id:'c1',title:'old',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const localBridge={links:[{itemId:'001',conceptId:'c1'}],orphanedLinks:[],catalog:[]};
const localPayload={version:2,app:localApp,atlas:localAtlas,bridge:localBridge};
storage.set('ipe-learning-os-v4',JSON.stringify(localApp));
storage.set('concept-atlas-v3-feed',JSON.stringify(localAtlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(localBridge));

const remotePayload={
  version:2,
  app:{version:4,progress:{'001':{d0:'2026-07-25'}},notes:{'001':'new'},settings:{}},
  atlas:{concepts:[{id:'c1',title:'new',parents:[],related:[]}],frames:[],objects:[],keywords:[]},
  bridge:localBridge,
};
let commitCalls=0;
let historyCalls=0;
let remoteHash='';
async function fetchMock(url){
  const name=String(url).split('/').pop();
  if(name==='ipe_load_working_head'){
    return {
      ok:true,
      status:200,
      text:async()=>JSON.stringify([{
        revision:2,
        operation_id:'remote-operation',
        device_id:'remote-device',
        payload_hash:remoteHash,
        app_state:remotePayload.app,
        atlas_state:remotePayload.atlas,
        bridge_state:remotePayload.bridge,
        created_at:new Date().toISOString(),
      }]),
    };
  }
  if(name==='ipe_commit_working_state')commitCalls+=1;
  if(name==='ipe_create_history_snapshot')historyCalls+=1;
  throw new Error('unexpected RPC '+name);
}

let applied=null;
const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  structuredClone,
  navigator:{onLine:true},
  cloudCfg:()=>({url:'https://example.supabase.co',anonKey:'anon',syncKey:'secret',deviceAlias:'맥북'}),
  __ipeGetAppState:()=>localApp,
  v17StorageGet:key=>JSON.parse(localStorage.getItem(key)||'null'),
  bridge:()=>localBridge,
  v17FlushAllStores:async()=>({app:localApp,atlas:localAtlas,bridge:localBridge}),
  applySnapshotPayload:value=>{applied=structuredClone(value)},
};
const context={
  window,
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  navigator:window.navigator,
  fetch:fetchMock,
  console,
  setTimeout,
  clearTimeout,
  confirm:()=>false,
  Blob,
  URL,
  Date,
  Intl,
  Math,
  JSON,
  Uint8Array,
};
vm.runInNewContext(kernelSource,context);
vm.runInNewContext(syncSource,context);

const localHash=await window.IpePersistenceKernel.hash(localPayload);
remoteHash=await window.IpePersistenceKernel.hash(remotePayload);
window.IpeNormalizedSync.meta();
const metaKey=[...storage.keys()].find(key=>key.startsWith('ipe-normalized-sync-v3:'));
const storedMeta=JSON.parse(storage.get(metaKey));
storage.set(metaKey,JSON.stringify({
  ...storedMeta,
  serverRevision:1,
  lastPayloadHash:localHash,
  dirty:false,
  serverState:'saved',
}));

const result=await window.IpeNormalizedSync.startupCheck();
assert.equal(result.fastForwarded,true,'a clean stale device must apply the newer server head automatically');
assert.equal(applied.app.notes['001'],'new');
assert.equal(window.IpeNormalizedSync.meta().serverRevision,2);
assert.equal(window.IpeNormalizedSync.meta().dirty,false);
assert.equal(commitCalls,0,'startup fast-forward must never upload the stale local payload');
assert.equal(historyCalls,0,'startup fast-forward must not create a named recovery snapshot');

console.log('normalized startup barrier: ok');
