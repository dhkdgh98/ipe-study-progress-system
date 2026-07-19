import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('/* v21: button-free concept autosave');
const end=source.indexOf('/* New concepts belong',start);
const autosave=source.slice(start,end);

assert.ok(start>=0&&end>start,'concept autosave patch must exist');
assert.doesNotMatch(source,/data-v20-save-concept/,'concept editor must not expose a manual save button');
assert.match(autosave,/c\[t\.dataset\.bindC\]=t\.value/,'field input must update the concept immediately');
assert.match(autosave,/line\.text=t\.value/,'note input must update the concept immediately');
assert.match(autosave,/saveDebounced\(\)/,'typing must use debounced persistence');
assert.doesNotMatch(autosave,/render(?:Feed|Inspector|Nav)?\(/,'typing must not trigger an editor or feed rerender');

console.log('atlas concept autosave regression: ok');
