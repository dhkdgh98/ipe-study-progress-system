import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync(new URL('../persistence-kernel.js',import.meta.url),'utf8');
const storage=new Map();
const localStorage={
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key),
};
const legacy={
  version:2,
  app:{version:4,progress:{'001':{d0:'2026-07-24'}},notes:{},settings:{}},
  atlas:{concepts:[{id:'c1',parents:[],related:[]}],frames:[],objects:[],keywords:[]},
  bridge:{links:[{itemId:'001',conceptId:'c1'}],orphanedLinks:[],catalog:[]},
};
storage.set('ipe-learning-os-v4',JSON.stringify(legacy.app));
storage.set('concept-atlas-v3-feed',JSON.stringify(legacy.atlas));
storage.set('ipe-atlas-bridge-v1',JSON.stringify(legacy.bridge));

const window={
  crypto:webcrypto,
  TextEncoder,
  localStorage,
  structuredClone,
  navigator:{},
};
vm.runInNewContext(source,{window,console,setTimeout,clearTimeout,Date,Math,JSON,Uint8Array});
const kernel=window.IpePersistenceKernel;
kernel.configure({
  legacyReader:async()=>structuredClone(legacy),
  validate:payload=>({ok:!!(payload?.app&&payload?.atlas&&payload?.bridge),errors:[]}),
});

const migration=await kernel.initialize();
assert.equal(migration.migrated,true,'legacy data must migrate into the canonical snapshot');
assert.equal((await kernel.readSnapshot()).payload.atlas.concepts[0].id,'c1');
assert.ok(storage.has('ipe-learning-os-v4'),'verified migration must retain legacy recovery keys');

const remote={
  workspaceKey:'workspace-a',
  syncId:'sync-a',
  writeHash:'write-a',
  expectedRevision:0,
  deviceId:'device-a',
};
const firstPayload=structuredClone(legacy);
firstPayload.app.notes['001']='first';
const first=await kernel.writeSnapshot(firstPayload,{reason:'first-edit',remote});
assert.ok(first.operation?.operationId,'a configured write must create a durable operation');

const secondPayload=structuredClone(firstPayload);
secondPayload.app.notes['001']='second';
const second=await kernel.writeSnapshot(secondPayload,{reason:'second-edit',remote});
assert.equal(second.operation.operationId,first.operation.operationId,'unsent edits must coalesce without changing operation id');

const claimed=await kernel.claimNext(remote.workspaceKey);
assert.equal(claimed.operationId,first.operation.operationId);
assert.equal(claimed.payload.app.notes['001'],'second','the claimed operation must contain the newest coalesced snapshot');
await kernel.markFailed(claimed.operationId,new Error('response lost'));
const retry=await kernel.claimNext(remote.workspaceKey);
assert.equal(retry.operationId,claimed.operationId,'a response-loss retry must reuse the persistent operation id');

const thirdPayload=structuredClone(secondPayload);
thirdPayload.app.notes['001']='third';
const third=await kernel.writeSnapshot(thirdPayload,{reason:'edit-during-flight',remote});
assert.notEqual(third.operation.operationId,retry.operationId,'an edit made after transmission begins must create a following operation');

await kernel.markAcked(retry.operationId,{revision:1,payloadHash:retry.payloadHash});
await kernel.rebasePending(remote.workspaceKey,1);
const following=(await kernel.listOutbox(remote.workspaceKey)).find(row=>row.operationId===third.operation.operationId);
assert.equal(following.expectedRevision,1,'the following unsent operation must rebase after the prior acknowledgement');

const lock=await kernel.withWriterLock(remote.workspaceKey,async()=>42);
assert.equal(lock.acquired,true);
assert.equal(lock.value,42);

const cleared=await kernel.clearAllData();
assert.equal(cleared.cleared,true);
assert.equal(await kernel.readSnapshot(),null,'forced replacement must remove the prior canonical snapshot');
assert.equal((await kernel.listOutbox()).length,0,'forced replacement must discard every pending working operation');
assert.equal((await kernel.listCheckpoints()).length,0,'forced replacement must discard local checkpoints');

console.log('persistence kernel: ok');
