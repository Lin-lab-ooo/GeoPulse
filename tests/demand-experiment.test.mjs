import test from 'node:test';
import assert from 'node:assert/strict';
import {demandTrialPlan,summarizeDemandFrames} from '../public/js/demand-experiment.js';

test('Demand comparison pairs both policies in each scene and alternates order by round',()=>{
  const plan=demandTrialPlan();assert.equal(plan.length,30);
  for(let repeat=1;repeat<=5;repeat++)for(const scene of ['idle','motion','updates']){
    const pair=plan.filter(value=>value.repeat===repeat&&value.scenario===scene);
    assert.deepEqual(pair.map(value=>value.policy),repeat%2?['continuous','demand']:['demand','continuous']);
    assert.ok(pair.every(value=>value.total===30));
  }
  assert.throws(()=>demandTrialPlan(0),RangeError);
  assert.throws(()=>demandTrialPlan(6),RangeError);
});
test('Sleeping is zero observed draws and unknown per-draw time, rather than fake fast frames',()=>{
  assert.deepEqual(summarizeDemandFrames([],1500),{businessFrames:0,businessFramesPerSecond:0,drawCalls:0,
    verticesSubmitted:0,renderBodyCpuMs:0,renderBodyCpuP95Ms:null,pulseFrames:0});
});
test('Work totals retain repeated submitted vertices and actual pulse frames',()=>{
  const value=summarizeDemandFrames([{frameMs:2,drawCalls:4,vertices:100,pulseActive:true},
    {frameMs:3,drawCalls:4,vertices:100,pulseActive:false}],1000);
  assert.equal(value.businessFramesPerSecond,2);assert.equal(value.verticesSubmitted,200);
  assert.equal(value.drawCalls,8);assert.equal(value.renderBodyCpuMs,5);assert.equal(value.renderBodyCpuP95Ms,3);
  assert.equal(value.pulseFrames,1);
});
