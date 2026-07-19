(function(root,factory){
  const create=factory();
  if(typeof module==='object'&&module.exports)module.exports=create;
  root.createAtlasLinkIndex=create;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  return function createAtlasLinkIndex({getLinks,getConcept}){
    let dirty=true,linksByConcept=new Map(),conceptIdsByItem=new Map();
    const rebuild=()=>{
      if(!dirty)return;
      linksByConcept=new Map();conceptIdsByItem=new Map();
      for(const link of getLinks()||[]){
        if(!linksByConcept.has(link.conceptId))linksByConcept.set(link.conceptId,[]);
        linksByConcept.get(link.conceptId).push(link);
        const itemId=String(link.itemId);
        if(!conceptIdsByItem.has(itemId))conceptIdsByItem.set(itemId,new Set());
        conceptIdsByItem.get(itemId).add(link.conceptId);
      }
      dirty=false;
    };
    const conceptsForItems=itemIds=>{
      rebuild();const ids=new Set();
      for(const itemId of itemIds||[])for(const conceptId of conceptIdsByItem.get(String(itemId))||[])ids.add(conceptId);
      return [...ids].map(getConcept).filter(Boolean);
    };
    return {
      invalidate(){dirty=true},
      linksForConcept(conceptId){rebuild();return linksByConcept.get(conceptId)||[]},
      conceptsForItem(itemId){return conceptsForItems([itemId])},
      conceptsForItems
    };
  };
});
