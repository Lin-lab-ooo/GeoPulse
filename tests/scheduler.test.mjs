import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveScheduler, percentile} from '../public/js/scheduler.js';
test('pressure reduces work, bounded stable-frame recovery', () => {
  const s = new AdaptiveScheduler();
  for (let i=1;i<=20;i++) s.update({p95:40, now:i*500});
  assert.equal(s.batchSize,256); assert.equal(s.budgetMs,1);
  for (let i=21;i<=120;i++) s.update({p95:16.7, now:i*500});
  assert.equal(s.batchSize,8192); assert.ok(s.budgetMs<=6); assert.ok(s.changes.length>0);
});
test('fixed mode stays fixed under pressure', () => {
  const s = new AdaptiveScheduler('fixed'); s.update({p95:100,interacting:true,now:1000});
  assert.equal(s.batchSize,2048); assert.equal(s.budgetMs,8);
});
test('nearest-rank P95 preserves long frames', () => {
  assert.equal(percentile([1,2,3,4,100],.95),100); assert.equal(percentile([],.95),null);
});
test('refresh rate calibration reacts to a 240 Hz display slowing to 120 Hz',()=>{
  const s=new AdaptiveScheduler('adaptive',{referenceMs:4.17});
  s.update({p95:8.4,now:1000});
  assert.ok(s.batchSize<2048);assert.ok(s.budgetMs<=2.1);
});
