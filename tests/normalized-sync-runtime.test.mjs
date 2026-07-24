import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const storage=new Map();
const window={
  crypto:webcrypto,
  TextEncoder,
  structuredClone,
  navigator:{onLine:true},
  localStorage:{
    getItem:key=>storage.get(key)??null,
    setItem:(key,value)=>storage.set(key,String(value)),
    removeItem:key=>storage.delete(key),
  },
  __ipeGetAppState:()=>({version:4,progress:{},notes:{},settings:{examDate:'2026-08-07',supabaseSync:{syncKey:'must-not-leak'}}}),
  v17StorageGet:key=>JSON.parse(storage.get(key)??'null'),
};
const context={window,crypto:webcrypto,TextEncoder,localStorage:window.localStorage,console,setTimeout,clearTimeout,confirm:()=>false,Blob,URL};
vm.runInNewContext(fs.readFileSync(new URL('../persistence-kernel.js',import.meta.url),'utf8'),context);
vm.runInNewContext(fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8'),context);

const validate=window.IpeNormalizedSync.validate;
storage.set('concept-atlas-v3-feed',JSON.stringify({concepts:[],frames:[],objects:[],keywords:[]}));
storage.set('ipe-atlas-bridge-v1',JSON.stringify({links:[],catalog:[]}));
assert.equal(window.IpeNormalizedSync.localPayload().app.settings.supabaseSync,undefined,'sync credentials must remain device-local');
assert.equal(window.IpeNormalizedSync.localPayload().atlas.concepts.length,0,'the browser storage adapter must use the explicit Atlas key');
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

const emptyAtlasWithHistory={app:{},atlas:{concepts:[],frames:[],objects:[],keywords:[]},bridge:{links:[],orphanedLinks:[{itemId:'011',conceptId:'missing'}]}};
assert.equal(validate(emptyAtlasWithHistory).ok,false,'an empty Atlas must not be accepted when study-link history exists');

context.confirm=()=>true;
window.applySnapshotPayload=()=>{
  storage.set('concept-atlas-v3-feed',JSON.stringify({concepts:[],frames:[],objects:[],keywords:[]}));
  storage.set('ipe-atlas-bridge-v1',JSON.stringify({links:[],catalog:[]}));
};
const importResult=await window.IpeNormalizedSync.importAtlasFile({text:async()=>JSON.stringify(base)});
assert.equal(importResult.audit.ok,true,'valid integrated backup must import');
assert.equal(window.IpeNormalizedSync.localPayload().atlas.concepts.length,1,'the canonical kernel snapshot must survive an immediate empty iframe overwrite');
assert.ok(storage.has('ipe-normalized-pending-import-v2'),'the compatibility recovery marker must remain until iframe acknowledgement');

storage.delete('ipe-normalized-pending-import-v2');
storage.set('concept-atlas-v3-feed',JSON.stringify(base.atlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(base.bridge));
const incompleteBackup={version:2,app:{progress:{'001':{d0:'2026-07-24'}},notes:{},settings:{}},atlas:{concepts:[],frames:[],objects:[],keywords:[]},bridge:base.bridge};
const recoveredResult=await window.IpeNormalizedSync.importFile({text:async()=>JSON.stringify(incompleteBackup)});
assert.equal(recoveredResult.audit.ok,true,'an incomplete new backup may reuse an intact current Atlas after confirmation');
assert.equal(window.IpeNormalizedSync.localPayload().atlas.concepts.length,1,'the current Atlas body must survive an incomplete backup import');

console.log('normalized sync runtime: ok');
