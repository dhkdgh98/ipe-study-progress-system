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
const app={version:4,progress:{'001':{d0:'2026-07-24'}},notes:{},settings:{}};
const atlas={concepts:[{id:'c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const bridge={links:[{itemId:'001',conceptId:'c1'}],orphanedLinks:[],catalog:[]};
storage.set('ipe-learning-os-v4',JSON.stringify(app));
storage.set('concept-atlas-v3-feed',JSON.stringify(atlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(bridge));

const commitBodies=[];
let remote=null;
async function fetchMock(url,options={}){
  const name=String(url).split('/').pop();
  if(name==='ipe_commit_state'){
    const body=JSON.parse(options.body);
    commitBodies.push(body);
    if(!remote){
      remote={
        revision:1,
        operation_id:body.p_operation_id,
        payload_hash:body.p_payload_hash,
        app_state:body.p_app,
        atlas_state:body.p_atlas,
        bridge_state:body.p_bridge,
        created_at:new Date().toISOString(),
      };
      throw new Error('response lost after server commit');
    }
    assert.equal(body.p_operation_id,remote.operation_id,'the server only accepts this as an idempotent replay');
    return {ok:true,status:200,text:async()=>JSON.stringify([{revision:1,committed_at:remote.created_at,replayed:true}])};
  }
  if(name==='ipe_load_head'){
    return {ok:true,status:200,text:async()=>JSON.stringify([remote])};
  }
  throw new Error('unexpected RPC '+name);
}

const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  structuredClone,
  navigator:{onLine:true},
  cloudCfg:()=>({url:'https://example.supabase.co',anonKey:'anon',syncKey:'secret'}),
  __ipeGetAppState:()=>app,
  v17StorageGet:key=>JSON.parse(localStorage.getItem(key)||'null'),
  bridge:()=>bridge,
  v17FlushAllStores:async()=>({app,atlas,bridge,source:'test'}),
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
  Math,
  JSON,
  Uint8Array,
};
vm.runInNewContext(kernelSource,context);
vm.runInNewContext(syncSource,context);

await assert.rejects(
  window.IpeNormalizedSync.flushNow('response-loss-test'),
  /네트워크 연결 실패/,
  'the first lost response must leave the operation pending',
);
await new Promise(resolve=>setTimeout(resolve,1900));

assert.equal(commitBodies.length,2,'the durable retry must run automatically');
assert.equal(commitBodies[0].p_operation_id,commitBodies[1].p_operation_id,'the same operation id must survive response loss');
assert.equal(commitBodies[0].p_payload_hash,commitBodies[1].p_payload_hash);
assert.equal(window.IpeNormalizedSync.meta().serverRevision,1);
assert.equal(window.IpeNormalizedSync.meta().serverState,'saved');
assert.equal(window.IpeNormalizedSync.meta().dirty,false);

console.log('normalized outbox retry: ok');
