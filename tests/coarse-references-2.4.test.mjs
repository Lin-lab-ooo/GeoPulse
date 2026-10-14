import test from 'node:test';
import assert from 'node:assert/strict';
import { CoarseSpatialIndex } from '../public/js/coarse-spatial-index.js';
import { primitiveBounds, rectangleClassifier, randomFor, snapshot } from '../tools/fixtures/coarse-reference-test-2.4.mjs';

function verify(index,positions,view){const classify=rectangleClassifier(view),found=[],count=index.count(classify),queried=index.query(classify,start=>found.push(start));
  assert.deepEqual(queried,count);assert.equal(new Set(found).size,found.length,'reference lists may not overlap');assert.equal(found.length,count.primitivesSelected);
  const listed=new Set(found),size=index.primitiveSize;let reference=0;
  for(let start=0;start<index.indexedUntil;start+=size){if(classify(primitiveBounds(positions,start,size))!==-1){reference++;assert.ok(listed.has(start),'complete primitive bbox reference missing');}}
  assert.ok(count.containedPrimitives<=reference&&reference<=count.primitivesSelected);
  for(const start of found){assert.equal(start%size,0);assert.ok(start>=0&&start+size<=index.indexedUntil);}
  return found;
}
test('default count-only usage retains its payload and does not allocate reference arrays',()=>{
  const index=new CoarseSpatialIndex({maxBuckets:16}),positions=new Float32Array([0,0,100,100]);index.append(positions,0,2);
  const stats=index.getStats();assert.equal(stats.typedArrayBytes,16*52);assert.equal(stats.referenceBytes,0);assert.equal(stats.referencesEnabled,false);assert.equal(stats.referenceCapacity,null);
  assert.equal(index._next,null);assert.equal(index._heads,null);assert.throws(()=>index.query(()=>1,()=>{}),/referenceCapacity/);
});
test('declared reference capacity is primitive count and fixed memory is reported before filling',()=>{
  for(const size of[1,2,3]){const index=new CoarseSpatialIndex({primitiveSize:size,maxBuckets:16,referenceCapacity:100}),stats=index.getStats();
    assert.equal(stats.referenceBytes,100*2+16*4);assert.equal(stats.coarseTypedArrayBytes,16*52);assert.equal(stats.typedArrayBytes,16*52+100*2+16*4);
    assert.equal(stats.referenceCapacity,100);assert.equal(stats.referencesEnabled,true);assert.equal(stats.primitives,0);assert.deepEqual(index.query(()=>1,()=>{}),index.count(()=>1));}
  const empty=new CoarseSpatialIndex({referenceCapacity:0});assert.equal(empty.getStats().referenceBytes,256*4);assert.equal(empty.query(()=>1,()=>{}).primitivesSelected,0);
  for(const input of[{referenceCapacity:-1},{referenceCapacity:1.5},{referenceCapacity:65536},{primitiveSize:2,referenceCapacity:32768},{primitiveSize:3,referenceCapacity:21846},{referenceCapacity:'10'}])assert.throws(()=>new CoarseSpatialIndex(input),RangeError);
});
test('coincident points and alternating distant clusters retain every original start',()=>{
  for(const coincident of[true,false]){const n=400,positions=new Float32Array(n*2),index=new CoarseSpatialIndex({referenceCapacity:n,maxBuckets:4});
    for(let i=0;i<n;i++){positions[i*2]=coincident?-100:i%2?-10000:10000;positions[i*2+1]=coincident?-100:i%2?-10000:10000;}
    for(let start=0;start<n;start+=17)index.append(positions,start,Math.min(n,start+17));
    const all=verify(index,positions,{minX:-20000,minY:-20000,maxX:20000,maxY:20000}).sort((a,b)=>a-b);assert.deepEqual(all,Array.from({length:n},(_,i)=>i));
    verify(index,positions,{minX:-500,minY:-500,maxX:500,maxY:500});
  }
});
test('negative cells and repeated folding concatenate lists without rescanning or losing starts',()=>{
  for(const size of[1,2,3]){const n=2400,positions=new Float32Array(n*size*2),index=new CoarseSpatialIndex({primitiveSize:size,referenceCapacity:n,maxBuckets:4});
    for(let i=0;i<n;i++){const scale=2**Math.floor(i/48),sx=i%2?-1:1,sy=i%3?-1:1;for(let k=0;k<size;k++){positions[(i*size+k)*2]=sx*scale*(1+k*.2);positions[(i*size+k)*2+1]=sy*scale*(1+k*.3);}}
    for(let at=0;at<n;at+=31){index.append(positions,at*size,Math.min(n,at+31)*size);const all=[];const stats=index.query(()=>1,start=>all.push(start));assert.equal(stats.primitivesSelected,Math.min(n,at+31));assert.equal(new Set(all).size,all.length);}
    assert.ok(index.merges>10);assert.ok(index.getStats().buckets<=4);
    verify(index,positions,{minX:-1000,minY:-1000,maxX:1000,maxY:1000});
  }
});
test('line and nondegenerate triangle crossing a viewport are retained with original starts',()=>{
  for(const size of[2,3]){const coordinates=size===2?[-1000,0,2000,0]:[-1000,-10,2000,-10,2000,100],positions=Float32Array.from(coordinates),index=new CoarseSpatialIndex({primitiveSize:size,referenceCapacity:1});
    index.append(positions,0,size);assert.deepEqual(verify(index,positions,{minX:-20,minY:-20,maxX:20,maxY:20}),[0]);
  }
});
test('capacity and finite-coordinate validation leave arrays, bounds, links and watermark unchanged',()=>{
  const positions=new Float32Array([0,0,1,1,2,2,3,3,4,4,5,5]),index=new CoarseSpatialIndex({primitiveSize:2,referenceCapacity:2});index.append(positions,0,2);const before=snapshot(index);
  for(const[values,start,end]of[[positions,0,2],[positions,2,3],[positions,3,4],[positions,2,6],[new Float32Array([0,0,1,1,NaN,2,3,3]),2,4]]){
    assert.throws(()=>index.append(values,start,end));assert.deepEqual(snapshot(index),before);}
  index.append(positions,2,4);assert.equal(index.indexedUntil,4);assert.deepEqual(index.query(()=>1,()=>{}),index.count(()=>1));
});
test('all Uint16-safe capacities include the last start and never confuse the sentinel',()=>{
  for(const size of[1,2,3]){const n=Math.floor(65535/size),positions=new Float32Array(n*size*2),index=new CoarseSpatialIndex({primitiveSize:size,referenceCapacity:n});
    for(let i=0;i<n;i++)for(let k=0;k<size;k++){positions[(i*size+k)*2]=(i%256)-128+k;positions[(i*size+k)*2+1]=Math.floor(i/256)-128+k;}
    for(let at=0;at<n;at+=2048)index.append(positions,at*size,Math.min(n,at+2048)*size);
    const found=[];index.query(()=>1,start=>found.push(start));found.sort((a,b)=>a-b);assert.equal(found.length,n);assert.equal(found[0],0);assert.equal(found.at(-1),(n-1)*size);
    assert.equal(index._next[n-1],0xffff);assert.equal(new Set(found).size,n);
  }
});
test('streamed fuzz conservatively enumerates full primitives through different folds and arrival scales',()=>{
  for(const seed of[7,19,41])for(const size of[1,2,3]){const rng=randomFor(seed),n=800,positions=new Float32Array(n*size*2),index=new CoarseSpatialIndex({primitiveSize:size,referenceCapacity:n,maxBuckets:seed===7?4:16});
    for(let i=0;i<n;i++)for(let k=0;k<size;k++){positions[(i*size+k)*2]=(rng()-.5)*(i<32?8:20000);positions[(i*size+k)*2+1]=(rng()-.5)*(i<32?8:20000);}
    let at=0;while(at<n){const end=Math.min(n,at+1+Math.floor(rng()*43));index.append(positions,at*size,end*size);at=end;for(let query=0;query<3;query++){const x=(rng()-.5)*18000,y=(rng()-.5)*18000;verify(index,positions,{minX:x,minY:y,maxX:x+600,maxY:y+600});}}
    const all=[];index.query(()=>1,start=>all.push(start));assert.deepEqual(all.sort((a,b)=>a-b),Array.from({length:n},(_,i)=>i*size));
  }
});
test('query validates callbacks and guards corrupt lists instead of looping indefinitely',()=>{
  const index=new CoarseSpatialIndex({referenceCapacity:2}),positions=new Float32Array([0,0,0,0]);index.append(positions,0,2);
  assert.throws(()=>index.query(null,()=>{}),TypeError);assert.throws(()=>index.query(()=>1,null),TypeError);assert.throws(()=>index.query(()=>2,()=>{}),RangeError);
  index._next[1]=0;assert.throws(()=>index.query(()=>1,()=>{}),/reference chain/);
});
