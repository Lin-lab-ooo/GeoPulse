import test from 'node:test';
import assert from 'node:assert/strict';
import {markRunOutcome,runOutcome} from '../public/js/run-outcome.js';

test('failed runs freeze the end clock and preserve partial acknowledged count',()=>{
 const state={started:100,shown:2048,config:{count:10000},finished:false,cancelled:false};
 markRunOutcome(state,'failed',1350,new Error('bad line'));
 const first=runOutcome(state,2000),later=runOutcome(state,9000);
 assert.deepEqual(first,later);
 assert.equal(first.state,'failed');assert.equal(first.elapsedMs,1250);assert.equal(first.submitted,2048);
 assert.equal(first.timeLabel,'失败');assert.equal(first.progressLabel,'失败（部分已提交）');
 assert.equal(state.failureReason,'bad line');assert.equal(state.cancelled,true);
 assert.ok(Number.isFinite(first.throughput));
});
test('user cancellation is distinct from successful completion, including zero submissions',()=>{
 const stopped={started:10,shown:0};markRunOutcome(stopped,'cancelled',60);
 assert.equal(runOutcome(stopped,1000).timeLabel,'已停止');assert.equal(runOutcome(stopped,1000).throughput,0);
 const complete={started:10,shown:10000};markRunOutcome(complete,'completed',60);
 assert.equal(runOutcome(complete,1000).progressLabel,'已完成');assert.equal(complete.cancelled,false);
});
test('missing legacy end time and zero duration never produce NaN or Infinity',()=>{
 const missing=runOutcome({started:10,finished:true,shown:1},100);
 assert.equal(missing.elapsedMs,null);assert.equal(missing.throughput,null);
 const instant={started:10,shown:1};markRunOutcome(instant,'failed',10);
 assert.equal(runOutcome(instant,100).throughput,null);
});
test('active timing advances, terminal input validation does not partially change state',()=>{
 const active={started:10,shown:3};assert.equal(runOutcome(active,60).elapsedMs,50);assert.equal(runOutcome(active,70).elapsedMs,60);
 assert.throws(()=>markRunOutcome(active,'failed',NaN));assert.deepEqual(active,{started:10,shown:3});
 assert.throws(()=>markRunOutcome(active,'unknown',40));assert.deepEqual(active,{started:10,shown:3});
});

test('partial geometry is distinguished from zero submission even before a full batch is acknowledged',()=>{
 const state={started:10,shown:0,uploadedVertices:8192,confirmedVertices:4096,acknowledgedVertices:0};
 markRunOutcome(state,'cancelled',50);const outcome=runOutcome(state,1000);
 assert.equal(outcome.progressLabel,'已停止（部分几何已确认）');assert.equal(outcome.submitted,0);
 assert.deepEqual(outcome.geometry,{stagedVertices:8192,confirmedVertices:4096,fullyAcknowledgedVertices:0,unacknowledgedConfirmedVertices:4096});
 const stagedOnly={started:10,shown:0,uploadedVertices:4096};markRunOutcome(stagedOnly,'failed',20);
 assert.equal(runOutcome(stagedOnly,1000).progressLabel,'失败（几何暂存，确认未完成）');
});
