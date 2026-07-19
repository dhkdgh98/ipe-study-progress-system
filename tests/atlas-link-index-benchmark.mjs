import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

await import('../atlas-link-index.js');
const concepts=Array.from({length:5000},(_,i)=>({id:`c${i}`}));
const conceptsById=new Map(concepts.map(c=>[c.id,c]));
const links=[];
for(let i=0;i<5000;i++)for(let j=0;j<3;j++)links.push({conceptId:`c${i}`,itemId:String((i+j)%157),role:j?'참조':'핵심'});
const index=globalThis.createAtlasLinkIndex({getLinks:()=>links,getConcept:id=>conceptsById.get(id)});

const started=performance.now();
for(let i=0;i<157;i++)index.conceptsForItem(String(i));
for(let i=0;i<5000;i++)index.linksForConcept(`c${i}`);
const elapsed=performance.now()-started;

assert.equal(index.linksForConcept('c0').length,3);
assert.ok(index.conceptsForItems(['0','1']).length>0);
assert.ok(elapsed<250,`indexed link lookup took ${elapsed.toFixed(1)}ms`);
console.log(JSON.stringify({concepts:5000,links:links.length,lookupMs:Number(elapsed.toFixed(1))},null,2));
