/** Small correctness helpers, not a performance model. */
export function primitiveBounds(positions,start,size){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=start;i<start+size;i++){minX=Math.min(minX,positions[i*2]);minY=Math.min(minY,positions[i*2+1]);maxX=Math.max(maxX,positions[i*2]);maxY=Math.max(maxY,positions[i*2+1]);}
  return{minX,minY,maxX,maxY};
}
export function rectangleClassifier(view){return b=>b.maxX<view.minX||b.minX>view.maxX||b.maxY<view.minY||b.minY>view.maxY?-1:
  b.minX>=view.minX&&b.maxX<=view.maxX&&b.minY>=view.minY&&b.maxY<=view.maxY?1:0;}
export function randomFor(seed){return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);}
export function snapshot(index){return{stats:index.getStats(),indexedUntil:index.indexedUntil,buckets:[...index._buckets],bounds:[...index._bounds],cells:[...index._cells],counts:[...index._counts],
  next:index._next?[...index._next]:null,heads:index._heads?[...index._heads]:null,tails:index._tails?[...index._tails]:null};}
