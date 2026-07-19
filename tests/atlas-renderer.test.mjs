import assert from 'node:assert/strict';

const callbacks=[];
globalThis.requestAnimationFrame=callback=>{callbacks.push(callback);return callbacks.length};
globalThis.cancelAnimationFrame=()=>{};
await import('../atlas-renderer.js');

const calls=[];
const renderer=globalThis.createAtlasRenderController({
  regions:{filters:()=>calls.push('filters'),toc:()=>calls.push('toc'),feed:()=>calls.push('feed'),inspector:()=>calls.push('inspector')},
  order:['filters','toc','feed','inspector']
});

renderer.request(['feed','toc']);
renderer.request(['feed','inspector']);
assert.equal(callbacks.length,1,'multiple requests in one frame must be coalesced');
callbacks.shift()();
assert.deepEqual(calls,['toc','feed','inspector'],'regions must render once in stable order');

calls.length=0;
renderer.now(['feed']);
assert.deepEqual(calls,['feed'],'immediate rendering must target only requested regions');

console.log('atlas renderer: ok');
