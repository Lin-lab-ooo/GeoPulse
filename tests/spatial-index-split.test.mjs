import test from 'node:test';
import assert from 'node:assert/strict';
import {PrimitiveSpatialIndex as Current} from '../public/js/spatial-index.js';
import {PrimitiveSpatialIndex as Previous} from '../tools/fixtures/spatial-index-1.6.mjs';

const classify=view=>bounds=>bounds.maxX<view.minX||bounds.minX>view.maxX||bounds.maxY<view.minY||bounds.minY>view.maxY?-1:
  bounds.minX>=view.minX&&bounds.maxX<=view.maxX&&bounds.minY>=view.minY&&bounds.maxY<=view.maxY?1:0;
const collect=(index,view)=>{const starts=[];const metrics=index.query(classify(view),start=>starts.push(start));return{starts:starts.sort((a,b)=>a-b),metrics,count:index.count(classify(view))};};
for(const primitiveSize of [1,2,3])test(`cached split centers preserve 1.6 conservative candidates for ${primitiveSize}-vertex primitives`,()=>{
  const count=1200,positions=new Float32Array(count*primitiveSize*2);
  let seed=20261009;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let p=0;p<count;p++){
    const repeated=p%4===0,base=p%2?900:-900;
    const x=repeated?base:base+random()*200-100,y=repeated?base:base+random()*200-100;
    for(let v=0;v<primitiveSize;v++)positions.set([x+(v?random()*80:0),y+(v?random()*80:0)],(p*primitiveSize+v)*2);
  }
  const options={primitiveSize,leafSize:8,minExtent:0,maxDepth:16};
  const current=new Current(options),previous=new Previous(options);
  for(let start=0;start<count;start+=37){const end=Math.min(count,start+37);current.append(positions,start*primitiveSize,end*primitiveSize);previous.append(positions,start*primitiveSize,end*primitiveSize);}
  assert.deepEqual(current.getStats(),previous.getStats());
  for(let sample=0;sample<40;sample++){
    const x=random()*2400-1200,y=random()*2400-1200,extent=random()*450;
    const view={minX:x-extent,minY:y-extent,maxX:x+extent,maxY:y+extent};
    assert.deepEqual(collect(current,view),collect(previous,view));
  }
});

test('cached split arithmetic preserves finite extreme and tiny Float32 centers',()=>{
  for(const magnitude of [3e38,1e-30]){
    const positions=new Float32Array(256*2);
    for(let i=0;i<256;i++)positions.set([((i%17)-8)/8*magnitude,((i%11)-5)/5*magnitude],i*2);
    const current=new Current({leafSize:4,minExtent:0}),previous=new Previous({leafSize:4,minExtent:0});
    current.append(positions,0,256);previous.append(positions,0,256);
    assert.deepEqual(current.getStats(),previous.getStats());
    for(const multiplier of [-1,0,1])assert.deepEqual(collect(current,{minX:multiplier*magnitude-magnitude/4,minY:-magnitude/4,maxX:multiplier*magnitude+magnitude/4,maxY:magnitude/4}),collect(previous,{minX:multiplier*magnitude-magnitude/4,minY:-magnitude/4,maxX:multiplier*magnitude+magnitude/4,maxY:magnitude/4}));
  }
});
test('bounded splitting keeps late outliers and coincident centers without a giant split',()=>{
  const count=10000,positions=new Float32Array((count+2)*2);
  positions.set([100000,100000],count*2);positions.set([-100000,-100000],(count+1)*2);
  const index=new Current({leafSize:64,minExtent:0,maxSplitEntries:256});
  for(let start=0;start<count;start+=128)index.append(positions,start,Math.min(count,start+128));
  index.append(positions,count,count+1);index.append(positions,count+1,count+2);
  assert.equal(index.getStats().nodes,1);assert.equal(index.splitLimitedLeaves,1);
  assert.equal(index.getStats().primitives,count+2);
  for(const xy of [0,100000,-100000]){const selected=collect(index,{minX:xy-1,minY:xy-1,maxX:xy+1,maxY:xy+1});assert.equal(selected.starts.length,count+2);}
  assert.equal(collect(index,{minX:200000,minY:200000,maxX:200001,maxY:200001}).starts.length,0);
  for(const invalid of [0,-1,NaN,1.5])assert.throws(()=>new Current({maxSplitEntries:invalid}),RangeError);
});
