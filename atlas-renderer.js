(function(root,factory){
  const create=factory();
  if(typeof module==='object'&&module.exports)module.exports=create;
  root.createAtlasRenderController=create;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  return function createAtlasRenderController({regions,order=Object.keys(regions),onError=()=>{}}){
    const dirty=new Set();
    let frame=0;

    const runRegion=region=>{
      const renderer=regions[region];
      if(!renderer)return;
      try{renderer()}catch(error){onError(region,error)}
    };
    const flush=()=>{
      frame=0;
      const requested=new Set(dirty);dirty.clear();
      order.forEach(region=>{if(requested.has(region))runRegion(region)});
    };
    const request=requested=>{
      (Array.isArray(requested)?requested:[requested]).forEach(region=>dirty.add(region));
      if(!frame)frame=requestAnimationFrame(flush);
    };
    const now=requested=>{
      (Array.isArray(requested)?requested:[requested]).forEach(runRegion);
    };
    const cancel=()=>{if(frame)cancelAnimationFrame(frame);frame=0;dirty.clear()};

    return {request,now,flush,cancel};
  };
});
