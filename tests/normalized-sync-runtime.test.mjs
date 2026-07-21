import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const storage=new Map();
const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},
  __ipeGetAppState:()=>({version:4,progress:{},notes:{},settings:{examDate:'2026-08-07',supabaseSync:{syncKey:'must-not-leak'}}}),
};
const context={window,crypto:webcrypto,TextEncoder,localStorage:window.localStorage,console,setTimeout,clearTimeout,confirm:()=>false,Blob,URL};
vm.runInNewContext(fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8'),context);

const validate=window.IpeNormalizedSync.validate;
storage.set('concept-atlas-v3-feed',JSON.stringify({concepts:[],frames:[],objects:[],keywords:[]}));
storage.set('ipe-atlas-bridge-v1',JSON.stringify({links:[],catalog:[]}));
assert.equal(window.IpeNormalizedSync.localPayload().app.settings.supabaseSync,undefined,'sync credentials must remain device-local');
const base={
  app:{},
  atlas:{
    concepts:[{id:'c1',parents:[],related:[]}],
    objects:[{id:'o1'}],
    frames:[{id:'f1',members:['c1','o1']}],
  },
  bridge:{links:[{itemId:'011',conceptId:'c1',role:'핵심'}]},
};
assert.equal(validate(base).ok,true,'concept and object frame members must both be valid');

const dangling=structuredClone(base);
dangling.bridge.links.push({itemId:'012',conceptId:'missing',role:'핵심'});
assert.equal(validate(dangling).ok,false,'dangling study links must fail validation');
assert.equal(validate(dangling).dangling.length,1);

const missingFrameMember=structuredClone(base);
missingFrameMember.atlas.frames[0].members.push('missing-object');
assert.equal(validate(missingFrameMember).ok,false,'missing frame members must fail validation');

context.confirm=()=>true;
window.applySnapshotPayload=()=>{
  storage.set('concept-atlas-v3-feed',JSON.stringify({concepts:[],frames:[],objects:[],keywords:[]}));
  storage.set('ipe-atlas-bridge-v1',JSON.stringify({links:[],catalog:[]}));
};
const importResult=await window.IpeNormalizedSync.importAtlasFile({text:async()=>JSON.stringify(base)});
assert.equal(importResult.audit.ok,true,'valid integrated backup must import');
assert.equal(window.IpeNormalizedSync.localPayload().atlas.concepts.length,1,'pending import must survive an immediate empty iframe overwrite');
assert.ok(storage.has('ipe-normalized-pending-import-v2'),'import must remain durable until iframe acknowledgement');

console.log('normalized sync runtime: ok');
