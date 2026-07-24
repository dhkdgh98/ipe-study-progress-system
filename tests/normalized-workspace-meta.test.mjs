import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync(new URL('../normalized-sync.js',import.meta.url),'utf8');
const storage=new Map();
const localStorage={
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key),
};
const config={url:'https://example.supabase.co',anonKey:'anon',syncKey:'workspace-secret-a'};
const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  cloudCfg:()=>config,
};
vm.runInNewContext(source,{
  window,
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  console,
  setTimeout,
  clearTimeout,
  Blob,
  URL,
});

window.IpeNormalizedSync.meta();
const keyA=[...storage.keys()].find(key=>key.startsWith('ipe-normalized-sync-v3:'));
const metaA=JSON.parse(storage.get(keyA));
metaA.serverRevision=9;
metaA.lastPayloadHash='hash-a';
storage.set(keyA,JSON.stringify(metaA));

config.syncKey='workspace-secret-b';
const metaB=window.IpeNormalizedSync.meta();
const scopedKeys=[...storage.keys()].filter(key=>key.startsWith('ipe-normalized-sync-v3:'));
assert.equal(scopedKeys.length,2,'each sync key needs an independent metadata scope');
assert.equal(metaB.serverRevision,0,'a new workspace must not inherit the prior revision');
assert.equal(metaB.lastPayloadHash,'','a new workspace must not inherit the prior payload hash');
assert.ok(scopedKeys.every(key=>!key.includes('workspace-secret')),'the raw sync key must not appear in a storage key');

config.syncKey='workspace-secret-a';
assert.equal(window.IpeNormalizedSync.meta().serverRevision,9,'returning to a workspace must restore only its own revision');

console.log('normalized workspace metadata: ok');
