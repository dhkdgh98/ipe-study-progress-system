import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

assert.match(source,/id="atlasParking"/,'Atlas frames need an out-of-view persistent host');
assert.match(source,/function parkAtlasFrames\(\)/,'main renders must preserve live Atlas frames');
assert.match(source,/parkAtlasFrames\(\);\s*\n\$\('#activeDate'\)/,'frames must be parked before #main is replaced');
assert.match(source,/if\(!frame\)\{[\s\S]*frame\.srcdoc=getAtlasHtml\(\)/,'srcdoc must only be assigned when a frame is first created');
assert.doesNotMatch(source,/<iframe id="studyAtlas"/,'study markup must not create a fresh iframe');
assert.doesNotMatch(source,/<iframe id="globalAtlas"/,'global markup must not create a fresh iframe');
assert.match(source,/host\.appendChild\(frame\)/,'a preserved frame must be reattached to the visible host');

console.log('atlas lifecycle regression: ok');
