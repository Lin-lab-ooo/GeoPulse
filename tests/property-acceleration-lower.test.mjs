import test from 'node:test';
import assert from 'node:assert/strict';
import { CoarseSpatialIndex } from '../tools/fixtures/property-2.3/coarse-with-lower.js';
import { decideSpatialWork } from '../public/js/spatial-work-policy.js';
import { generatePropertyCase } from '../tools/property-acceleration-2.3.mjs';
import { runLowerPropertyCase } from '../tools/property-acceleration-2.3.lower.mjs';

test('contained coarse buckets prove a lower bound even when an upper bound is very loose', () => {
  const positions=new Float32Array(400);
  for(let i=0;i<200;i++){positions[i*2]=i;positions[i*2+1]=i%2?20:100;}
  const index=new CoarseSpatialIndex({maxBuckets:4});index.append(positions,0,200);
  const counted=index.count(b=>b.minY>65||b.maxY<55?-1:0);
  assert.equal(counted.containedPrimitives,0);
  assert.ok(counted.primitivesSelected>30);
  const input={primitiveCount:200,coarseUpperBound:counted.primitivesSelected,coarseLowerBound:counted.containedPrimitives,coarseComplete:true};
  assert.equal(decideSpatialWork(input).action,'refine');
  assert.equal(decideSpatialWork({...input,denseGate:'upper-heuristic'}).action,'dense-fallback');
});
test('proven dense policy agrees with the actual frozen 2.2 fine density decision', () => {
  const data=generatePropertyCase('uniform',7,1000);
  const result=runLowerPropertyCase(data,{name:'partial',x:1000,y:0,width:10000,height:12000,heading:0},{rounds:1});
  assert.equal(result.lower.action,'dense-fallback');
  assert.equal(result.measurements[0].baselineFineDense,true);
  assert.equal(result.lower.quality.candidateIdsEqualToBaseline,true);
  assert.equal(result.lower.quality.coldCoarseFalseDenseAgainstFine,false);
  assert.ok(result.lowerBound<=result.bboxReferenceCount&&result.bboxReferenceCount<=result.upperBound);
});
test('a crossing long line cannot enter the fully-contained lower count merely by its centroid', () => {
  const positions=new Float32Array([-1000,0,2000,0]),index=new CoarseSpatialIndex({primitiveSize:2});index.append(positions,0,2);
  const counted=index.count(b=>b.maxX< -20||b.minX>20?-1:b.minX>=-20&&b.maxX<=20?1:0);
  assert.equal(counted.primitivesSelected,1);
  assert.equal(counted.containedPrimitives,0);
  assert.equal(decideSpatialWork({primitiveCount:1,coarseUpperBound:1,coarseLowerBound:0,coarseComplete:true}).action,'refine');
});
test('strong gate compares actual complete primitive counts consistently across geometry kinds', () => {
  for(const size of [1,2,3]) {
    const positions=new Float32Array(100*size*2);for(let i=0;i<positions.length;i+=2){positions[i]=i/2;positions[i+1]=0;}
    const index=new CoarseSpatialIndex({primitiveSize:size});index.append(positions,0,100*size);
    const counted=index.count(()=>1);
    assert.equal(counted.containedPrimitives,100);
    assert.equal(counted.primitivesSelected,100);
  }
});
