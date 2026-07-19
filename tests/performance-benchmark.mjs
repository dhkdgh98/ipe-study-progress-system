import '../atlas-performance.js';
import '../atlas-map.js';

const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const SECTIONS=[['detail','세부'],['why','이유'],['condition','조건'],['rule','규칙'],['limit','제약'],['example','예시'],['trap','함정']];

function syntheticState(size=5000){
  const keywords=Array.from({length:size},(_,i)=>`키워드 ${i}`);
  const concepts=Array.from({length:size},(_,i)=>({
    id:`c${i}`,title:`개념 ${i}`,domain:`영역 ${i%20}`,definition:`정의 ${i}`,
    parents:i?[`c${Math.floor((i-1)/3)}`]:[],primaryParent:i?`c${Math.floor((i-1)/3)}`:'',
    related:[`c${(i+1)%size}`,`c${(i+97)%size}`],conceptRole:['core','support','general'][i%3],importance:i%4,
    sections:Object.fromEntries(SECTIONS.map(([key],sectionIndex)=>[key,[{id:`l${i}-${sectionIndex}`,text:`설명 ${i}-${sectionIndex}`,keywords:[keywords[(i+sectionIndex)%size]]}]]))
  }));
  const frames=Array.from({length:Math.floor(size/2)},(_,i)=>({id:`f${i}`,title:`프레임 ${i}`,type:['classification','comparison','procedure','structure'][i%4],anchorId:`c${i}`,members:[`c${i}`,`c${(i+1)%size}`]}));
  return {concepts,frames,keywords};
}

const state=syntheticState();
const bridge=Array.from({length:15000},(_,i)=>({conceptId:`c${i%5000}`,itemId:`item${i%157}`}));
const started=performance.now();
const runtime=globalThis.createAtlasPerformanceRuntime({
  getState:()=>state,getUi:()=>({filter:'all',selected:{kind:'concept',id:'c0'}}),getBridgeLinks:()=>bridge,
  sections:SECTIONS,query:()=>null,escape:String,conceptCard:()=>'',frameCard:()=>'',feedHeader:()=>'',initLazyGraphs:()=>{}
});
const buildMs=performance.now()-started;

let lookupStarted=performance.now();
for(let i=0;i<30000;i++)assert(runtime.conceptById(`c${i%5000}`),'indexed concept lookup failed');
for(let i=0;i<5000;i++){runtime.children(`c${i}`);runtime.framesFor(`c${i}`);runtime.bridgeLinksFor(`c${i}`)}
const lookupMs=performance.now()-lookupStarted;

const migrationStarted=performance.now();
const migrated=globalThis.AtlasPerformanceMigration.migrateSnapshot(state);
const migrationMs=performance.now()-migrationStarted;
assert(migrated.schemaVersion===2,'schema migration version mismatch');
assert(migrated.report.ok,'valid synthetic snapshot rejected');
assert(migrated.report.counts.concepts===5000,'concept count changed during migration');

const map=globalThis.createAtlasMapRuntime({getState:()=>state,getPerformance:()=>runtime,sections:SECTIONS,openConcept:()=>{}});
const graphStarted=performance.now();
const graph=map.buildGraph(state.concepts);
const graphMs=performance.now()-graphStarted;
assert(graph.nodes.length===10000,'map must include concepts and keywords');
assert(graph.edges.some(edge=>edge.type==='hierarchy'),'hierarchy edges missing');
assert(graph.edges.some(edge=>edge.type==='related'),'related edges missing');
assert(graph.edges.some(edge=>edge.type==='keyword'),'keyword edges missing');

assert(buildMs<500,`index build regression: ${buildMs.toFixed(1)}ms`);
assert(lookupMs<250,`indexed lookup regression: ${lookupMs.toFixed(1)}ms`);
assert(migrationMs<1500,`migration regression: ${migrationMs.toFixed(1)}ms`);
assert(graphMs<600,`map graph regression: ${graphMs.toFixed(1)}ms`);

console.log(JSON.stringify({dataset:{concepts:5000,keywords:5000,frames:2500,bridgeLinks:15000},buildMs:+buildMs.toFixed(1),lookupMs:+lookupMs.toFixed(1),migrationMs:+migrationMs.toFixed(1),graphMs:+graphMs.toFixed(1),mapNodes:graph.nodes.length,mapEdges:graph.edges.length},null,2));
