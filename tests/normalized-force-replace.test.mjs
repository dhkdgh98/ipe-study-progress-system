import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const kernelSource=fs.readFileSync(new URL('../persistence-kernel.js',import.meta.url),'utf8');
const syncSource=fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8');
const storage=new Map();
const localStorage={
  get length(){return storage.size},
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key),
  key:index=>[...storage.keys()][index]??null,
  clear:()=>storage.clear(),
};
const syncConfig={url:'https://example.supabase.co',anonKey:'anon',syncKey:'secret',deviceAlias:'맥북'};
const localApp={version:4,progress:{},notes:{'001':'stale-local'},settings:{supabaseSync:syncConfig}};
const localAtlas={concepts:[{id:'local-c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const localBridge={links:[{itemId:'001',conceptId:'local-c1'}],orphanedLinks:[],catalog:[]};
const localPayload={version:2,app:{...localApp,settings:{}},atlas:localAtlas,bridge:localBridge};
storage.set('ipe-learning-os-v4',JSON.stringify(localApp));
storage.set('concept-atlas-v3-feed',JSON.stringify(localAtlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(localBridge));
storage.set('stale-extra-key','must-disappear');

const serverPayload={
  app:{version:4,progress:{'009':{d0:'2026-07-25'}},notes:{'009':'server-latest'},settings:{}},
  atlas:{concepts:[{id:'server-c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]},
  bridge:{links:[{itemId:'009',conceptId:'server-c1'}],orphanedLinks:[],catalog:[]},
};
const historyPayload={
  app:{version:4,progress:{'009':{d0:'2026-07-20'}},notes:{'009':'named-history'},settings:{}},
  atlas:{concepts:[{id:'history-c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]},
  bridge:{links:[{itemId:'009',conceptId:'history-c1'}],orphanedLinks:[],catalog:[]},
};
let serverHash='';
let historyHash='';
async function fetchMock(url){
  const name=String(url).split('/').pop();
  if(name==='ipe_load_working_head'){
    return {ok:true,status:200,text:async()=>JSON.stringify([{
      revision:7,
      operation_id:'server-operation',
      device_id:'desktop',
      payload_hash:serverHash,
      app_state:serverPayload.app,
      atlas_state:serverPayload.atlas,
      bridge_state:serverPayload.bridge,
      created_at:new Date().toISOString(),
    }])};
  }
  if(name==='ipe_load_history'){
    return {ok:true,status:200,text:async()=>JSON.stringify([{
      history_id:'11111111-1111-4111-8111-111111111111',
      label:'소프트웨어 설계 › UML · 데스크탑 · 07/24 21:34',
      payload_hash:historyHash,
      app_state:historyPayload.app,
      atlas_state:historyPayload.atlas,
      bridge_state:historyPayload.bridge,
      created_at:new Date().toISOString(),
    }])};
  }
  throw new Error('unexpected RPC '+name);
}

let applied=null;
const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  structuredClone,
  navigator:{onLine:true},
  cloudCfg:()=>syncConfig,
  __ipeGetAppState:()=>localApp,
  v17StorageGet:key=>JSON.parse(localStorage.getItem(key)||'null'),
  bridge:()=>localBridge,
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
  confirm:()=>{throw new Error('forced replacement must not ask for confirmation')},
  Blob,
  URL,
  Date,
  Math,
  JSON,
  Uint8Array,
};
vm.runInNewContext(kernelSource,context);
vm.runInNewContext(syncSource,context);

serverHash=await window.IpePersistenceKernel.hash({version:2,...serverPayload});
historyHash=await window.IpePersistenceKernel.hash({version:2,...historyPayload});
await window.IpePersistenceKernel.writeSnapshot(localPayload,{
  reason:'stale-local',
  remote:{workspaceKey:'workspace',syncId:'workspace',writeHash:'write',expectedRevision:6,deviceId:'mac'},
});
await window.IpePersistenceKernel.checkpoint(localPayload,{source:'old-checkpoint'});

const latest=await window.IpeNormalizedSync.pull();
assert.equal(latest.forced,true);
assert.equal(applied.app.notes['009'],'server-latest');
assert.equal(storage.has('stale-extra-key'),false,'server latest must clear every old localStorage key');
assert.equal(JSON.parse(storage.get('ipe-learning-os-v4')).settings.supabaseSync.deviceAlias,'맥북','sync configuration must be re-seeded with the server copy');
assert.equal((await window.IpePersistenceKernel.listOutbox()).length,0);
assert.equal((await window.IpePersistenceKernel.listCheckpoints()).length,0);
assert.equal((await window.IpePersistenceKernel.readSnapshot()).payloadHash,serverHash);
assert.equal(window.IpeNormalizedSync.meta().dirty,false);

storage.set('another-stale-key','must-also-disappear');
await window.IpePersistenceKernel.checkpoint({version:2,...serverPayload},{source:'new-checkpoint'});
const restored=await window.IpeNormalizedSync.loadHistory('11111111-1111-4111-8111-111111111111');
assert.equal(restored.forced,true);
assert.equal(restored.restorePending,true,'an older named snapshot must remain local until the user saves it back to the server');
assert.equal(applied.app.notes['009'],'named-history');
assert.equal(storage.has('another-stale-key'),false);
assert.equal((await window.IpePersistenceKernel.listCheckpoints()).length,0);
assert.equal((await window.IpePersistenceKernel.readSnapshot()).payloadHash,historyHash);
assert.equal(window.IpeNormalizedSync.meta().serverState,'restore-pending');

console.log('normalized forced replacement: ok');
