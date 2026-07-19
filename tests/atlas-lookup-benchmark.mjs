const SIZE=5000;
const concepts=Array.from({length:SIZE},(_,index)=>({
  id:`c${index}`,
  primaryParent:index?`c${Math.floor((index-1)/3)}`:''
}));
const frames=Array.from({length:2500},(_,index)=>({id:`f${index}`,anchorId:`c${index}`}));

const started=performance.now();
const conceptById=new Map(concepts.map(concept=>[concept.id,concept]));
const frameById=new Map(frames.map(frame=>[frame.id,frame]));
const childrenByParent=new Map();
const framesByAnchor=new Map();
for(const concept of concepts){
  if(!concept.primaryParent)continue;
  if(!childrenByParent.has(concept.primaryParent))childrenByParent.set(concept.primaryParent,[]);
  childrenByParent.get(concept.primaryParent).push(concept);
}
for(const frame of frames){
  if(!framesByAnchor.has(frame.anchorId))framesByAnchor.set(frame.anchorId,[]);
  framesByAnchor.get(frame.anchorId).push(frame);
}
const buildMs=performance.now()-started;

const lookupStarted=performance.now();
for(let index=0;index<30000;index++){
  if(!conceptById.get(`c${index%SIZE}`))throw new Error('concept lookup failed');
}
for(let index=0;index<SIZE;index++){
  childrenByParent.get(`c${index}`);
  framesByAnchor.get(`c${index}`);
}
for(let index=0;index<frames.length;index++){
  if(!frameById.get(`f${index}`))throw new Error('frame lookup failed');
}
const lookupMs=performance.now()-lookupStarted;

if(buildMs>250)throw new Error(`index build regression: ${buildMs.toFixed(1)}ms`);
if(lookupMs>150)throw new Error(`lookup regression: ${lookupMs.toFixed(1)}ms`);
console.log(JSON.stringify({concepts:SIZE,frames:frames.length,buildMs:+buildMs.toFixed(1),lookupMs:+lookupMs.toFixed(1)},null,2));
