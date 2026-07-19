globalThis.requestAnimationFrame=()=>0;
await import('../atlas-map.js');

const SIZE=5000,sections=[['detail'],['why'],['condition'],['rule'],['limit'],['example'],['trap']];
const concepts=Array.from({length:SIZE},(_,index)=>({
  id:`c${index}`,title:`개념 ${index}`,parents:index?[`c${Math.floor((index-1)/3)}`]:[],
  primaryParent:index?`c${Math.floor((index-1)/3)}`:'',related:[`c${(index+1)%SIZE}`],
  conceptRole:['core','support','general'][index%3],
  sections:Object.fromEntries(sections.map(([key],offset)=>[key,[{keywords:[`키워드 ${(index+offset)%SIZE}`]}]]))
}));
const conceptById=new Map(concepts.map(concept=>[concept.id,concept])),childrenByParent=new Map();
for(const concept of concepts){if(!concept.primaryParent)continue;if(!childrenByParent.has(concept.primaryParent))childrenByParent.set(concept.primaryParent,[]);childrenByParent.get(concept.primaryParent).push(concept)}
const runtime=globalThis.createAtlasMapRuntime({
  getPerformance:()=>({conceptById:id=>conceptById.get(id),children:id=>childrenByParent.get(id)||[]}),
  sections,openConcept:()=>{}
});
const started=performance.now(),graph=runtime.buildGraph(concepts);runtime.layout(graph);const layoutMs=performance.now()-started;
const cells=new Map(),cellSize=100;
for(const node of graph.nodes.filter(node=>node.kind==='concept')){
  const key=`${Math.floor(node.x/cellSize)},${Math.floor(node.y/cellSize)}`;
  for(const other of cells.get(key)||[]){const distance=Math.hypot(node.x-other.x,node.y-other.y);if(distance<node.radius+other.radius)throw new Error(`overlap: ${node.id}/${other.id}`)}
  if(!cells.has(key))cells.set(key,[]);cells.get(key).push(node);
}
if(layoutMs>1200)throw new Error(`map layout regression: ${layoutMs.toFixed(1)}ms`);
console.log(JSON.stringify({concepts:SIZE,nodes:graph.nodes.length,edges:graph.edges.length,layoutMs:+layoutMs.toFixed(1)},null,2));
