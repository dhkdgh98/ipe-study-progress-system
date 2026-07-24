import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8');
const storage=new Map([
  ['ipe-learning-os-v4',JSON.stringify({version:4,progress:{'001':{d0:'2026-07-24',reviews:{}}},notes:{'001':'keep'},settings:{supabaseSync:{syncKey:'local-only'}}})],
  ['concept-atlas-v3-feed',JSON.stringify({concepts:[{id:'c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]})],
  ['ipe-atlas-bridge-v1',JSON.stringify({links:[{itemId:'001',conceptId:'c1',role:'핵심'}],orphanedLinks:[],catalog:[]})],
]);

function loadRuntime(){
  const localStorage={
    getItem:key=>storage.get(key)??null,
    setItem:(key,value)=>storage.set(key,String(value)),
    removeItem:key=>storage.delete(key),
  };
  const window={
    crypto:webcrypto,
    TextEncoder,
    localStorage,
    __ipeGetAppState:()=>JSON.parse(storage.get('ipe-learning-os-v4')),
    v17StorageGet:key=>JSON.parse(storage.get(key)??'null'),
    bridge:()=>JSON.parse(storage.get('ipe-atlas-bridge-v1')),
  };
  const context={window,crypto:webcrypto,TextEncoder,localStorage,console,setTimeout,clearTimeout,confirm:()=>false,Blob,URL};
  vm.runInNewContext(source,context);
  return window.IpeNormalizedSync;
}

const before={
  app:storage.get('ipe-learning-os-v4'),
  atlas:storage.get('concept-atlas-v3-feed'),
  bridge:storage.get('ipe-atlas-bridge-v1'),
};
const first=loadRuntime();
assert.equal(first.localPayload().atlas.concepts.length,1);
assert.equal(first.localPayload().bridge.links.length,1);

const second=loadRuntime();
assert.equal(second.localPayload().app.progress['001'].d0,'2026-07-24');
assert.equal(second.localPayload().atlas.concepts[0].id,'c1');
assert.equal(second.localPayload().bridge.links[0].conceptId,'c1');
assert.equal(storage.get('ipe-learning-os-v4'),before.app,'runtime reload must not rewrite App data');
assert.equal(storage.get('concept-atlas-v3-feed'),before.atlas,'runtime reload must not rewrite Atlas data');
assert.equal(storage.get('ipe-atlas-bridge-v1'),before.bridge,'runtime reload must not rewrite Bridge data');

console.log('normalized refresh persistence: ok');
