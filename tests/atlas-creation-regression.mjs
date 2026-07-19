import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const runtimeStart=source.indexOf('function atlasRuntimePatch(){');
const runtimeEnd=source.indexOf('\nfunction getAtlasHtml(){',runtimeStart);
assert.ok(runtimeStart>=0&&runtimeEnd>runtimeStart,'atlasRuntimePatch must exist');
const runtime=source.slice(runtimeStart,runtimeEnd);

const createStart=runtime.indexOf('createConcept=function(values={}){');
const createEnd=runtime.indexOf('\n  };',createStart);
assert.ok(createStart>=0&&createEnd>createStart,'runtime createConcept override must exist');
const createConcept=runtime.slice(createStart,createEnd);

assert.match(createConcept,/state\.concepts\.push\(c\)/,'new concepts must enter the global concept collection');
assert.match(createConcept,/bridgeContext\?\.itemId/,'creation must inspect the active learning context');
assert.match(createConcept,/bridgeAddLink\(c\.id,bridgeContext\.itemId,'핵심'\)/,'every creation path must link to the active learning item');
assert.match(createConcept,/createdAt,updatedAt:createdAt/,'new concepts must retain timestamps');

console.log('atlas creation regression: ok');
