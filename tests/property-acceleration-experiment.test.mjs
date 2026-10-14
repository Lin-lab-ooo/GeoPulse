import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePropertyCase, propertyProfile, runPropertyCase } from '../tools/property-acceleration-2.3.mjs';

test('properties distinguish a narrow corridor and complete long primitives', () => {
  const uniform=propertyProfile(generatePropertyCase('uniform',7,1000));
  const corridor=propertyProfile(generatePropertyCase('narrow-corridor',7,1000));
  const lines=propertyProfile(generatePropertyCase('long-crossing-lines',7,1000));
  assert.ok(corridor.centerCovarianceEigenvalueRatio>uniform.centerCovarianceEigenvalueRatio*1000);
  assert.equal(uniform.completeBoundsCrossing256mCellRatio,0);
  assert.equal(lines.completeBoundsCrossing256mCellRatio,1);
});
test('dense partial pages avoid a real client copy and Worker mirror/index build', () => {
  const data=generatePropertyCase('uniform',7,1000);
  const result=runPropertyCase(data,{name:'partial',x:1000,y:0,width:10000,height:12000,heading:0},{rounds:1});
  assert.equal(result.action,'dense-fallback');
  assert.equal(result.gatedWorkerRequired,false);
  assert.ok(result.measurements[0].baseline.workerAppends>0);
  assert.ok(result.measurements[0].baseline.mirrorBytes>0);
  assert.equal(result.measurements[0].gated.workerAppends,0);
  assert.equal(result.quality.everyReferenceRetained,true);
});
test('selective cold gate returns exactly the same fine candidates as the 2.2 Worker', () => {
  const data=generatePropertyCase('uniform',19,1000);
  const result=runPropertyCase(data,{name:'local',x:0,y:0,width:800,height:800,heading:.3},{rounds:1});
  assert.equal(result.action,'refine');
  assert.equal(result.quality.candidateIdsEqualToBaseline,true);
  assert.equal(result.quality.everyReferenceRetained,true);
});
test('long lines crossing the viewport retain candidates with centroids outside', () => {
  const data=generatePropertyCase('long-crossing-lines',41,1000);
  const result=runPropertyCase(data,{name:'center',x:0,y:0,width:800,height:800,heading:0},{rounds:1});
  assert.ok(result.quality.actualCrossingLineWithCentroidOutsideCount>0);
  assert.equal(result.quality.everyReferenceRetained,true);
});
test('fully contained or rejected pages are excluded from gate savings', () => {
  const data=generatePropertyCase('uniform',41,1000);
  for(const view of [{name:'contained',x:0,y:0,width:26000,height:26000,heading:0},
    {name:'outside',x:30000,y:30000,width:800,height:800,heading:0}]) {
    const result=runPropertyCase(data,view,{rounds:1});
    assert.equal(result.baselineWorkerRequired,false);
    assert.equal(result.gatedWorkerRequired,false);
    assert.equal(result.workerCpuSavedMs,0);
  }
});
