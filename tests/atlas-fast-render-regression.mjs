import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

assert.match(source,/window\.__atlasFastContextRender=\(\)=>/,'context changes need a dedicated partial renderer');
assert.match(source,/renderController\.now\(\['feed'\]\)/,'context changes must render only the feed');
assert.match(source,/window\.__atlasFastMutationRender=\(conceptIds=\[\],options=\{\}\)=>/,'mutations need a dedicated partial renderer');
assert.match(source,/renderController\.now\(\['feed','inspector'\]\)/,'concept mutations must avoid full filter and TOC renders');
assert.match(source,/compactSetPanel\('editor',true\);\\n    window\.__atlasFastMutationRender/,'new concept creation must use partial rendering');
assert.match(source,/window\.__atlasFastMutationRender\?\.\(\[p\.id,\.\.\.ids\]\)/,'child relations must use partial rendering');
assert.match(source,/window\.__atlasFastMutationRender\?\.\(\[id,\.\.\.ids\]\)/,'related relations must use partial rendering');

console.log('atlas fast render regression: ok');
