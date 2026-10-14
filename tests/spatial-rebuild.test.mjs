import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REBUILD_STRATEGIES, createRebuildPlan, buildReorderedIndex } from '../tools/fixtures/spatial-rebuild-2.3.mjs';
import { runRebuildDataset } from '../tools/rebuild-properties-2.3.mjs';
import { generatePropertyCase } from '../tools/property-acceleration-2.3.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
test('every bounded plan covers complete primitives exactly once for all geometry kinds', () => {
  for(const primitiveSize of [1,2,3])for(const count of [0,1,63,64,65,129,1000])for(const strategy of REBUILD_STRATEGIES) {
    const plan=createRebuildPlan({count,primitiveSize,strategy}),seen=new Uint8Array(count);
    for(let at=0;at<plan.ranges.length;at+=2){const start=plan.ranges[at],end=plan.ranges[at+1];assert.equal(start%primitiveSize,0);assert.equal(end%primitiveSize,0);assert.ok(end>start);assert.ok((end-start)/primitiveSize<=128);
      for(let i=start/primitiveSize;i<end/primitiveSize;i++)assert.equal(seen[i]++,0);}
    assert.equal(seen.reduce((a,b)=>a+b,0),count);
    assert.equal(plan.rangeCount,plan.ranges.length/2);
  }
});
test('global sample plus bounded ranges reduce monotonic depth saturation without reordering geometry', () => {
  const n=4096,positions=new Float32Array(n*2);for(let i=0;i<n;i++){positions[i*2]=i;positions[i*2+1]=0;}
  const before=hash(positions),base=buildReorderedIndex(positions,{strategy:'arrival',maxSplitEntries:Infinity}),rebuilt=buildReorderedIndex(positions,{strategy:'sample64-bit-reversal'});
  const classify=b=>b.maxX<2000||b.minX>2100?-1:b.minX>=2000&&b.maxX<=2100?1:0;
  assert.ok(rebuilt.index.count(classify).primitivesSelected<base.index.count(classify).primitivesSelected);
  assert.ok(rebuilt.treeShape.largestLeaf<base.treeShape.largestLeaf);
  assert.equal(hash(positions),before);
  assert.equal(rebuilt.indexStats.primitives,n);
  assert.ok(rebuilt.slices.every(slice=>slice.primitives<=128));
});
test('point, line and triangle rebuilding retains complete bbox intersections and original starts', () => {
  for(const size of [1,2,3]){
    const n=300,positions=new Float32Array(n*size*2);for(let i=0;i<n;i++)for(let k=0;k<size;k++){positions[(i*size+k)*2]=i-150+(k===1?120:k===2?60:0);positions[(i*size+k)*2+1]=k===1?20:k===2?-20:0;}
    const classify=b=>b.maxX< -10||b.minX>10||b.maxY< -10||b.minY>30?-1:0;
    for(const strategy of REBUILD_STRATEGIES){const built=buildReorderedIndex(positions,{primitiveSize:size,strategy}),found=[];built.index.query(classify,start=>found.push(start));const seen=new Set(found);
      for(let i=0;i<n;i++){const minX=i-150,maxX=minX+(size>1?120:0);if(maxX>=-10&&minX<=10)assert.ok(seen.has(i*size));}
      assert.equal(seen.size,found.length);for(const start of found)assert.equal(start%size,0);
    }
  }
});
test('pathological coincident primitives cap atomic split size while retaining every reference', () => {
  const n=1001,positions=new Float32Array(n*2);positions[(n-1)*2]=10000;
  const built=buildReorderedIndex(positions,{strategy:'arrival',maxSplitEntries:256});
  assert.equal(built.indexStats.primitives,n);assert.ok(built.treeShape.splitLimitedLeaves>0);
  let count=0;built.index.query(()=>0,()=>count++);assert.equal(count,n);
});
test('unsafe plans and partial geometry fail before building', () => {
  for(const value of [{count:-1},{count:10,primitiveSize:4},{count:10,strategy:'unknown'},{count:10,chunkPrimitives:257},{count:10,sampleCount:257}])assert.throws(()=>createRebuildPlan(value),RangeError);
  assert.throws(()=>buildReorderedIndex(new Float32Array(3)),RangeError);
});
test('research comparison checks actual frozen Worker candidates and budgets copy/plan/build costs', () => {
  const result=runRebuildDataset(generatePropertyCase('narrow-corridor',7,1000,'spatial-arrival'),{rounds:1,queryRepeats:1});
  assert.equal(result.originalWorkerCandidateIdentityChecked,true);
  assert.equal(result.sourceGeometryByteUnchanged,true);
  for(const method of Object.values(result.methods)){
    assert.ok(method.prepareAndBuildCpuMedianMs>=method.appendCpuMedianMs);
    assert.equal(method.geometryCopyBytes,8000);
    assert.ok(method.planTypedArrayBytes>0);
    assert.ok(method.views.every(view=>view.allReferencesRetained));
  }
});
