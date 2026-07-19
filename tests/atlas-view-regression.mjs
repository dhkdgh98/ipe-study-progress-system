import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

assert.match(source,/\.replace\("const FILTERS=.*\['related','개념 지도'\].*","const FILTERS=.*\['structure','구조'\]\];"\)/s,
  'the generated Atlas must remove the dedicated concept-map filter');
assert.match(source,/if\(ui\.filter==='related'\)ui\.filter='all'/,
  'stale concept-map state must fall back to the normal feed');

console.log('atlas view regression: ok');
