import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimitiveSpatialIndex } from '../tools/fixtures/research-2.2/public/js/spatial-index.js';
import { ACTIONS, FEATURE_NAMES, TREE_OPTIONS, PAGE_VERTICES, makeWorkload, workloadManifest,
  newCostState, makeCostContext, makeCostFeatures, advanceCostState, verifyQueries
} from '../tools/fixtures/spatial-cost-data-2.3.mjs';

test('workload fixture is deterministic and complete primitives fit every Uint16 page',()=>{
  for(const primitiveSize of [1,2,3]){
    const config={count:23000,primitiveSize,distribution:'clusters',seed:19,order:'alternating'};
    const a=makeWorkload(config),b=makeWorkload(config);
    assert.equal(a.geometryHash,b.geometryHash);assert.equal(a.id,b.id);
    assert.equal(a.pages.reduce((n,p)=>n+p.primitiveCount,0),config.count);
    let next=0;
    for(const page of a.pages){assert.equal(page.primitiveStart,next);assert.equal(page.positions.length,page.primitiveCount*primitiveSize*2);assert.ok(page.primitiveCount*primitiveSize<=PAGE_VERTICES);assert.ok([...page.positions].every(Number.isFinite));next+=page.primitiveCount;}
    assert.equal(a.pages.length,primitiveSize===3?2:1);
  }
});

test('all append actions preserve final trees and conservative candidates for point, line and triangle cases',()=>{
  for(const primitiveSize of [1,2,3])for(const distribution of ['uniform','clusters','corridor','crossing-lines']){
    const workload=makeWorkload({primitiveSize,distribution,count:700,seed:41,order:'shuffled'});let expected=null;
    for(const action of ACTIONS){
      const indexes=workload.pages.map(page=>{const index=new PrimitiveSpatialIndex({primitiveSize,...TREE_OPTIONS});for(let s=0;s<page.primitiveCount*primitiveSize;s+=action*primitiveSize)index.append(page.positions,s,Math.min(page.positions.length/2,s+action*primitiveSize));return index;});
      const result={stats:indexes.map(i=>i.getStats()),queries:verifyQueries(workload,indexes)};
      if(!expected)expected=result;else assert.deepEqual(result,expected);
    }
  }
});

test('before-slice profile is causal, finite and sees no future positions',()=>{
  const workload=makeWorkload({count:512,primitiveSize:2,distribution:'crossing-lines',seed:7}),page=workload.pages[0];
  const poisoned={...page,positions:page.positions.slice()};poisoned.positions.fill(1e20,128);
  const contexts=[];
  for(const p of [page,poisoned]){
    const index=new PrimitiveSpatialIndex({primitiveSize:2,...TREE_OPTIONS}),state=newCostState(p,2);
    const initial=makeCostContext(index,p,state);assert.equal(initial.indexedPrimitives,0);assert.equal(initial.bboxSpan,0);assert.equal(initial.emaMsPerPrimitive,0);
    index.append(p.positions,0,64);advanceCostState(state,p.positions,0,64,2);
    const context=makeCostContext(index,p,state),features=makeCostFeatures(context);
    assert.equal(features.length,FEATURE_NAMES.length);assert.ok(features.every(Number.isFinite));assert.equal(context.indexedPrimitives,32);assert.equal(context.remainingPrimitives,480);assert.equal(context.emaMsPerPrimitive,2/32);assert.equal(context.version,1);contexts.push(context);
  }
  assert.deepEqual(contexts[0],contexts[1]);
});

test('EMA updates strictly after current slice and partial append state cannot silently skip primitives',()=>{
  const workload=makeWorkload({count:64,primitiveSize:1}),page=workload.pages[0],state=newCostState(page,1);
  advanceCostState(state,page.positions,0,32,2);assert.equal(state.emaMsPerPrimitive,2/32);
  advanceCostState(state,page.positions,32,64,4);assert.equal(state.emaMsPerPrimitive,.2*(4/32)+.8*(2/32));assert.equal(state.version,2);
  assert.throws(()=>advanceCostState(state,page.positions,0,32,2),RangeError);
  assert.throws(()=>makeCostFeatures({}),TypeError);
});

test('manifest keeps entire seeds/pages/workflows in one split and holds out crossing distribution and large pages',()=>{
  const manifest=workloadManifest();assert.equal(manifest.length,72);assert.equal(new Set(manifest.map(w=>w.id)).size,72);
  const counts={};for(const w of manifest){counts[w.split]=(counts[w.split]||0)+1;if(w.config.distribution==='crossing-lines')assert.equal(w.split,'test-held-out-distribution');else if(w.config.count===60000)assert.equal(w.split,'test-large');else assert.equal(w.split,w.config.seed===7?'train':'validation');}
  assert.deepEqual(counts,{train:18,validation:18,'test-large':18,'test-held-out-distribution':18});
  assert.equal(workloadManifest({quick:true}).length,24);
});