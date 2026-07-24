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
const app={version:4,activeTab:'study',studyItemId:'009',progress:{},notes:{},settings:{}};
const atlas={concepts:[{id:'c1',title:'UML',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const bridge={links:[{itemId:'009',conceptId:'c1'}],orphanedLinks:[],catalog:[]};
storage.set('ipe-learning-os-v4',JSON.stringify(app));
storage.set('concept-atlas-v3-feed',JSON.stringify(atlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(bridge));

let remote=null;
let workingCalls=0;
const historyBodies=[];
async function fetchMock(url,options={}){
  const name=String(url).split('/').pop();
  if(name==='ipe_load_working_head'){
    return {ok:true,status:200,text:async()=>JSON.stringify(remote?[remote]:[])};
  }
  if(name==='ipe_commit_working_state'){
    workingCalls+=1;
    const body=JSON.parse(options.body);
    remote={
      revision:Number(body.p_expected_revision)+1,
      operation_id:body.p_operation_id,
      device_id:body.p_device_id,
      payload_hash:body.p_payload_hash,
      app_state:body.p_app,
      atlas_state:body.p_atlas,
      bridge_state:body.p_bridge,
      created_at:new Date().toISOString(),
    };
    return {ok:true,status:200,text:async()=>JSON.stringify([{revision:remote.revision,committed_at:remote.created_at,replayed:false}])};
  }
  if(name==='ipe_create_history_snapshot'){
    const body=JSON.parse(options.body);
    historyBodies.push(body);
    return {ok:true,status:200,text:async()=>JSON.stringify([{history_id:body.p_operation_id,created_at:new Date().toISOString(),replayed:false}])};
  }
  throw new Error('unexpected RPC '+name);
}

const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  structuredClone,
  navigator:{onLine:true},
  cloudCfg:()=>({url:'https://example.supabase.co',anonKey:'anon',syncKey:'secret',deviceAlias:'데스크탑'}),
  __ipeGetAppState:()=>app,
  __ipeGetEditContext:()=>({activeTab:'study',itemId:'009',subject:'소프트웨어 설계',name:'UML'}),
  v17StorageGet:key=>JSON.parse(localStorage.getItem(key)||'null'),
  bridge:()=>bridge,
  v17FlushAllStores:async()=>({app,atlas,bridge}),
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

await window.IpeNormalizedSync.flushNow('manual');
await window.IpeNormalizedSync.saveNamedHistory('manual',{skipFlush:true});
await window.IpeNormalizedSync.saveNamedHistory('manual',{skipFlush:true});

assert.equal(workingCalls,1,'manual save must update the mutable working head once');
assert.equal(historyBodies.length,1,'an unchanged payload must not create duplicate named history');
assert.equal(historyBodies[0].p_protocol_version,3);
assert.match(historyBodies[0].p_label,/소프트웨어 설계 › UML · 데스크탑 ·/);
assert.equal(historyBodies[0].p_app.notes['009'],undefined);
assert.equal(window.IpeNormalizedSync.meta().lastHistoryHash,remote.payload_hash);

console.log('normalized named history: ok');
