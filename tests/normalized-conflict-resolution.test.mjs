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
const app={version:4,progress:{'001':{d0:'2026-07-24'}},notes:{'001':'keep-local'},settings:{}};
const atlas={concepts:[{id:'local-c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]};
const bridge={links:[{itemId:'001',conceptId:'local-c1'}],orphanedLinks:[],catalog:[]};
storage.set('ipe-learning-os-v4',JSON.stringify(app));
storage.set('concept-atlas-v3-feed',JSON.stringify(atlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(bridge));

let remote={
  revision:1,
  operation_id:'remote-operation',
  payload_hash:'remote-hash',
  app_state:{version:4,progress:{},notes:{'001':'remote'},settings:{}},
  atlas_state:{concepts:[],frames:[],objects:[],keywords:[]},
  bridge_state:{links:[],orphanedLinks:[],catalog:[]},
  created_at:new Date().toISOString(),
};
let commitCalls=0;
async function fetchMock(url,options={}){
  const name=String(url).split('/').pop();
  if(name==='ipe_load_working_head')return {ok:true,status:200,text:async()=>JSON.stringify([remote])};
  if(name==='ipe_create_history_snapshot'){
    const body=JSON.parse(options.body);
    return {ok:true,status:200,text:async()=>JSON.stringify([{history_id:body.p_operation_id,created_at:new Date().toISOString(),replayed:false}])};
  }
  if(name==='ipe_commit_working_state'){
    commitCalls+=1;
    const body=JSON.parse(options.body);
    if(Number(body.p_expected_revision)!==remote.revision){
      return {
        ok:false,
        status:409,
        text:async()=>JSON.stringify({
          message:`revision conflict: expected ${body.p_expected_revision}, server is ${remote.revision}`,
          details:JSON.stringify({expected:body.p_expected_revision,actual:remote.revision}),
        }),
      };
    }
    remote={
      revision:remote.revision+1,
      operation_id:body.p_operation_id,
      payload_hash:body.p_payload_hash,
      app_state:body.p_app,
      atlas_state:body.p_atlas,
      bridge_state:body.p_bridge,
      created_at:new Date().toISOString(),
    };
    return {ok:true,status:200,text:async()=>JSON.stringify([{revision:remote.revision,committed_at:remote.created_at,replayed:false}])};
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
  confirm:()=>true,
  Blob,
  URL,
  Date,
  Math,
  JSON,
  Uint8Array,
};
vm.runInNewContext(kernelSource,context);
vm.runInNewContext(syncSource,context);

await assert.rejects(window.IpeNormalizedSync.flushNow('stale-write'),/서버 충돌을 먼저 해결해야 함/);
assert.equal(window.IpeNormalizedSync.meta().serverState,'conflict');
assert.equal(commitCalls,0,'the startup barrier must reject a stale upload before the commit RPC');

await assert.rejects(window.IpeNormalizedSync.flushNow('manual-during-conflict'),/서버 충돌을 먼저 해결해야 함/);
assert.equal(commitCalls,0,'ordinary manual save must not create a stale conflict operation');

const resolved=await window.IpeNormalizedSync.resolveConflictKeepLocal();
assert.equal(resolved.revision,2);
assert.equal(remote.app_state.notes['001'],'keep-local');
assert.equal(window.IpeNormalizedSync.meta().serverState,'saved');
assert.equal(window.IpeNormalizedSync.meta().dirty,false);
const rows=await window.IpePersistenceKernel.listOutbox();
assert.ok(rows.some(row=>row.status==='acked'&&row.revision===2),'the explicitly rebased local operation must be acknowledged');

console.log('normalized conflict resolution: ok');
