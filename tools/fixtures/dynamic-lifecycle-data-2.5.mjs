/** Independent canonical lifecycle data and scalar bbox oracle for 2.5 tests. */
export const PRIMITIVE_SIZE = Object.freeze({ points: 1, lines: 2, polygons: 3 });
export const VIEWS = Object.freeze({ A:{x:100,y:100,scale:6,heading:0}, B:{x:935,y:935,scale:6,heading:0}, MID:{x:500,y:500,scale:6,heading:0}, FULL:{x:520,y:520,scale:.4,heading:0}, ROTATED:{x:100,y:100,scale:5,heading:Math.PI/5} });
export function cloneGroup(g) { return {kind:g.kind,positions:g.positions.slice(),colors:g.colors.slice(),ids:g.ids.slice(),featureCount:g.featureCount}; }
export function makeLifecycleGroup(kind='points',count=512,firstID=1,{singleCluster=false,perVertex=false}={}) {
 const size=PRIMITIVE_SIZE[kind],positions=new Float32Array(count*size*2),colors=new Uint8Array(count*size*4),ids=new Uint32Array(count*size);
 for(let i=0;i<count;i++) { const center=i<2?100:singleCluster?70:i%2?900:70,x=center+(i<2?0:i%17*.2),y=center+(i<2?0:Math.floor(i/17)%17*.2);
  const xy=size===1?[x,y]:size===2?[x-4,y-4,x+4,y+4]:[x-4,y-4,x+4,y-4,x,y+4]; positions.set(xy,i*size*2);
  for(let v=0;v<size;v++) { colors.set(i<2?(perVertex?[40+v*25,210-v*25,70+v*40,35+v*44]:i===0?[40,220,60,115]:[220,50,90,97]):[20,130,220,67],(i*size+v)*4);ids[i*size+v]=firstID+i; }
 }
 return {kind,positions,colors,ids,featureCount:count};
}
export class CanonicalLifecycleState {
 constructor(groups=[]) { this.groups=[];this.removed=new Map();for(const g of groups)this.append(g); }
 each(id,visit) { for(const g of this.groups)for(let v=0;v<g.ids.length;v++)if(g.ids[v]===id)visit(g,v); }
 append(input) { const g=cloneGroup(input);for(let v=0;v<g.ids.length;v++){const saved=this.removed.get(g.ids[v]);if(saved){saved.push({g,v,rgba:g.colors.slice(v*4,v*4+4)});g.colors[v*4+3]=0;}}this.groups.push(g); }
 move(id,x,y) { if(this.removed.has(id))return;this.each(id,(g,v)=>g.positions.set([Math.fround(x),Math.fround(y)],v*2)); }
 moveBatch(updates) { const last=new Map(updates.map(u=>[u.id,u]));for(const {id,x,y}of last.values())this.move(id,x,y); }
 color(id,color) { if(this.removed.has(id))return;this.each(id,(g,v)=>g.colors.set(color,v*4)); }
 remove(ids) { for(const id of new Set(ids)){if(this.removed.has(id))continue;const rows=[];this.each(id,(g,v)=>{rows.push({g,v,rgba:g.colors.slice(v*4,v*4+4)});g.colors[v*4+3]=0;});if(rows.length)this.removed.set(id,rows);} }
 restore(ids) { for(const id of new Set(ids)){const rows=this.removed.get(id);if(!rows)continue;for(const {g,v,rgba}of rows)g.colors.set(rgba,v*4);this.removed.delete(id);} }
}
export function scalarPrimitiveBounds(positions,start,size) {
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let v=start;v<start+size;v++){const x=positions[v*2],y=positions[v*2+1];minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
 return {minX,minY,maxX,maxY};
}
/** A partially tombstoned primitive retains ALL vertex bounds; all removed is empty. */
export function scalarLiveBounds(positions,count,size,isRemoved=()=>false) {
 let result=null;
 for(let start=0;start<count;start+=size){let live=false;for(let v=start;v<start+size;v++)if(!isRemoved(v)){live=true;break;}if(!live)continue;
  const b=scalarPrimitiveBounds(positions,start,size);if(!result)result={...b};else{result.minX=Math.min(result.minX,b.minX);result.minY=Math.min(result.minY,b.minY);result.maxX=Math.max(result.maxX,b.maxX);result.maxY=Math.max(result.maxY,b.maxY);}}
 return result?{empty:false,...result}:{empty:true,minX:0,minY:0,maxX:0,maxY:0};
}
export function boundsContain(published,current) { return current.empty||!published.empty&&published.minX<=current.minX&&published.minY<=current.minY&&published.maxX>=current.maxX&&published.maxY>=current.maxY; }
/** Independent affine SAT. This does not call production projected-bounds. */
export function affineBoundsIntersects(b,m,{marginX=1,marginY=1}={}) {
 const p=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]].map(([x,y])=>[m[0]*x+m[4]*y+m[12],m[1]*x+m[5]*y+m[13]]);
 const axes=[[1,0],[0,1]];for(let i=0;i<4;i++){const q=p[(i+1)%4];axes.push([q[1]-p[i][1],p[i][0]-q[0]]);}
 for(const [nx,ny]of axes){if(Math.abs(nx)+Math.abs(ny)<1e-12)continue;let lo=Infinity,hi=-Infinity;for(const [x,y]of p){const d=nx*x+ny*y;lo=Math.min(lo,d);hi=Math.max(hi,d);}const r=Math.abs(nx)*marginX+Math.abs(ny)*marginY,eps=1e-10*(1+r+Math.max(Math.abs(lo),Math.abs(hi)));if(lo>r+eps||hi<-r-eps)return false;}
 return true;
}