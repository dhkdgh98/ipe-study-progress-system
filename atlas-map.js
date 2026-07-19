(function(global){
  'use strict';
  function createAtlasMapRuntime(api){
    const COLORS={core:'#ffca68',support:'#74dcff',general:'#b7a6ff',hierarchy:'#67d8ff',related:'#f39bc3',keyword:'#7ce5ad'};
    let serial=0,active=null;
    function buildGraph(baseConcepts){
      const perf=api.getPerformance(),baseIds=new Set(baseConcepts.map(c=>c.id)),conceptIds=new Set(baseIds);
      for(const concept of baseConcepts){for(const id of concept.parents||[])conceptIds.add(id);for(const child of perf.children(concept.id))conceptIds.add(child.id);for(const id of concept.related||[])conceptIds.add(id)}
      const concepts=[...conceptIds].map(perf.conceptById).filter(Boolean),visibleIds=new Set(concepts.map(c=>c.id)),nodes=[],edges=[],keywords=new Map();
      for(const concept of concepts){
        const childCount=perf.children(concept.id).length;
        nodes.push({id:concept.id,kind:'concept',title:concept.title,role:concept.conceptRole||'general',childCount,base:baseIds.has(concept.id),radius:24+Math.min(25,Math.sqrt(childCount)*8)});
        for(const parent of concept.parents||[])if(visibleIds.has(parent))edges.push({from:parent,to:concept.id,type:'hierarchy'});
        for(const related of concept.related||[])if(visibleIds.has(related)&&String(concept.id)<String(related))edges.push({from:concept.id,to:related,type:'related'});
        for(const [section] of api.sections)for(const line of concept.sections?.[section]||[])for(const word of line.keywords||[]){if(!word)continue;if(!keywords.has(word))keywords.set(word,new Set());keywords.get(word).add(concept.id)}
      }
      for(const [word,owners] of keywords){const id='kw:'+word;nodes.push({id,kind:'keyword',title:word,radius:15,childCount:0});for(const owner of owners)edges.push({from:owner,to:id,type:'keyword'})}
      return {nodes,edges,baseIds};
    }
    function layout(graph){
      const conceptNodes=graph.nodes.filter(n=>n.kind==='concept'),keywordNodes=graph.nodes.filter(n=>n.kind==='keyword'),parents=new Map(),depth=new Map();
      for(const edge of graph.edges)if(edge.type==='hierarchy'){if(!parents.has(edge.to))parents.set(edge.to,[]);parents.get(edge.to).push(edge.from)}
      function getDepth(id,seen=new Set()){if(depth.has(id))return depth.get(id);if(seen.has(id))return 0;seen.add(id);const value=parents.has(id)?1+Math.min(...parents.get(id).map(parent=>getDepth(parent,new Set(seen)))):0;depth.set(id,value);return value}
      const levels=new Map();for(const node of conceptNodes){const d=getDepth(node.id);if(!levels.has(d))levels.set(d,[]);levels.get(d).push(node)}
      for(const [level,items] of levels){items.sort((a,b)=>b.childCount-a.childCount||a.title.localeCompare(b.title));const columns=Math.max(1,Math.ceil(Math.sqrt(items.length*2)));items.forEach((node,index)=>{node.x=(index%columns)*150;node.y=level*145+Math.floor(index/columns)*95})}
      const maxConceptX=Math.max(0,...conceptNodes.map(n=>n.x)),kwColumns=Math.max(1,Math.ceil(Math.sqrt(keywordNodes.length)));
      keywordNodes.forEach((node,index)=>{node.x=maxConceptX+230+(index%kwColumns)*125;node.y=(index/kwColumns|0)*70});
      const minX=Math.min(0,...graph.nodes.map(n=>n.x)),minY=Math.min(0,...graph.nodes.map(n=>n.y));for(const node of graph.nodes){node.x-=minX-80;node.y-=minY-80}
    }
    function html(baseConcepts){
      const id='atlas-canvas-'+(++serial),graph=buildGraph(baseConcepts);layout(graph);requestAnimationFrame(()=>mount(id,graph));
      return `<div class="atlas-canvas-shell" id="${id}"><div class="atlas-canvas-toolbar"><span>Canvas 개념지도 · 드래그 이동 · 휠 확대/축소</span><span class="atlas-canvas-count">개념 ${graph.nodes.filter(n=>n.kind==='concept').length} · 키워드 ${graph.nodes.filter(n=>n.kind==='keyword').length} · 연결 ${graph.edges.length}</span><button type="button" data-map-fit>전체 맞춤</button><button type="button" data-map-fullscreen>전체화면</button></div><canvas tabindex="0" aria-label="무한 캔버스 개념지도"></canvas><div class="atlas-map-legend">● 핵심 · ● 보조 · ● 일반　→ 상위→하위　┄ 연관　·· 키워드</div></div>`;
    }
    function mount(id,graph){
      const shell=document.getElementById(id);if(!shell)return;if(active?.destroy)active.destroy();
      const canvas=shell.querySelector('canvas'),ctx=canvas.getContext('2d',{alpha:false}),byId=new Map(graph.nodes.map(n=>[n.id,n]));
      let dpr=Math.min(devicePixelRatio||1,2),view={x:0,y:0,scale:1},drag=null,raf=0,destroyed=false;
      const worldBounds={w:Math.max(500,...graph.nodes.map(n=>n.x+n.radius+80)),h:Math.max(400,...graph.nodes.map(n=>n.y+n.radius+80))};
      function resize(){const rect=canvas.getBoundingClientRect();canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,rect.height*dpr);draw()}
      function fit(){const rect=canvas.getBoundingClientRect();view.scale=Math.max(.08,Math.min(1.2,Math.min(rect.width/worldBounds.w,rect.height/worldBounds.h)*.92));view.x=(rect.width-worldBounds.w*view.scale)/2;view.y=(rect.height-worldBounds.h*view.scale)/2;draw()}
      function visible(node,rect){const x=node.x*view.scale+view.x,y=node.y*view.scale+view.y,r=node.radius*view.scale+20;return x+r>=0&&y+r>=0&&x-r<=rect.width&&y-r<=rect.height}
      function schedule(){if(raf)return;raf=requestAnimationFrame(()=>{raf=0;draw()})}
      function draw(){
        if(destroyed)return;const rect=canvas.getBoundingClientRect();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#07101c';ctx.fillRect(0,0,rect.width,rect.height);ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.scale,view.scale);ctx.lineCap='round';
        for(const edge of graph.edges){const a=byId.get(edge.from),b=byId.get(edge.to);if(!a||!b||(!visible(a,rect)&&!visible(b,rect)))continue;ctx.beginPath();ctx.moveTo(a.x,a.y);if(edge.type==='related')ctx.quadraticCurveTo((a.x+b.x)/2+18,(a.y+b.y)/2-18,b.x,b.y);else ctx.lineTo(b.x,b.y);ctx.strokeStyle=COLORS[edge.type];ctx.globalAlpha=edge.type==='keyword'?.2:.58;ctx.lineWidth=(edge.type==='hierarchy'?2.2:1.6)/view.scale;ctx.setLineDash(edge.type==='related'?[8/view.scale,7/view.scale]:edge.type==='keyword'?[2/view.scale,7/view.scale]:[]);ctx.stroke()}
        ctx.setLineDash([]);ctx.globalAlpha=1;
        for(const node of graph.nodes){if(!visible(node,rect))continue;ctx.beginPath();ctx.arc(node.x,node.y,node.radius,0,Math.PI*2);ctx.fillStyle=node.kind==='keyword'?'#102d2b':'#10223b';ctx.fill();ctx.strokeStyle=node.kind==='keyword'?COLORS.keyword:COLORS[node.role]||COLORS.general;ctx.lineWidth=(node.base?4:2)/view.scale;ctx.stroke();if(view.scale>.32){ctx.fillStyle='#eef7ff';ctx.font=`${Math.max(10,12/view.scale)}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';const max=node.kind==='keyword'?13:16,label=node.title.length>max?node.title.slice(0,max-1)+'…':node.title;ctx.fillText((node.kind==='keyword'?'#':'')+label,node.x,node.y-(node.kind==='concept'&&view.scale>.55?5:0));if(node.kind==='concept'&&view.scale>.55){ctx.fillStyle='#a9bbd2';ctx.font=`${Math.max(8,9/view.scale)}px system-ui`;ctx.fillText(`하위 ${node.childCount}`,node.x,node.y+13)}}}
        ctx.restore();
      }
      function point(event){const rect=canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top}}
      canvas.addEventListener('pointerdown',event=>{canvas.setPointerCapture(event.pointerId);drag={...point(event),vx:view.x,vy:view.y,moved:false}});
      canvas.addEventListener('pointermove',event=>{if(!drag)return;const p=point(event),dx=p.x-drag.x,dy=p.y-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;view.x=drag.vx+dx;view.y=drag.vy+dy;schedule()});
      canvas.addEventListener('pointerup',event=>{if(!drag)return;const moved=drag.moved,p=point(event);drag=null;if(moved)return;const wx=(p.x-view.x)/view.scale,wy=(p.y-view.y)/view.scale;let hit=null,best=Infinity;for(const node of graph.nodes){const d=(node.x-wx)**2+(node.y-wy)**2;if(d<node.radius**2&&d<best){hit=node;best=d}}if(hit?.kind==='concept')api.openConcept(hit.id)});
      canvas.addEventListener('wheel',event=>{event.preventDefault();const p=point(event),before={x:(p.x-view.x)/view.scale,y:(p.y-view.y)/view.scale};view.scale=Math.max(.06,Math.min(3,view.scale*Math.exp(-event.deltaY*.001)));view.x=p.x-before.x*view.scale;view.y=p.y-before.y*view.scale;schedule()},{passive:false});
      shell.querySelector('[data-map-fit]').onclick=fit;shell.querySelector('[data-map-fullscreen]').onclick=async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await shell.requestFullscreen();setTimeout(fit,80)};
      const observer=new ResizeObserver(resize);observer.observe(canvas);resize();fit();active={destroy(){destroyed=true;observer.disconnect();if(raf)cancelAnimationFrame(raf)}};
    }
    return {html,buildGraph};
  }
  global.createAtlasMapRuntime=createAtlasMapRuntime;
})(typeof window!=='undefined'?window:globalThis);
