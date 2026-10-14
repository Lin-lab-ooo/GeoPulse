import test from 'node:test';
import assert from 'node:assert/strict';
import {samplingWindowCoverage as coverage} from '../public/js/sampling-window.js';
test('end-tail blocking remains visible even when no closing rAF was sampled',()=>{
 const samples=[{atMs:10,intervalMs:10},{atMs:20,intervalMs:10},{atMs:30,intervalMs:10}];
 const before=JSON.stringify(samples),value=coverage(samples,1030);
 assert.equal(value.observedMaxIntervalMs,10);assert.equal(value.unclosedTailMs,1000);
 assert.equal(value.maxObservedOrTailMs,1000);assert.equal(value.callbacksPerSecond,3000/1030);
 assert.equal(JSON.stringify(samples),before);assert.equal(samples.length,3);
});
test('samples after loading and invalid timestamps do not inflate completed-window rate',()=>{
 const value=coverage([{atMs:10,intervalMs:10},{atMs:1100,intervalMs:1090},{atMs:-1,intervalMs:999},{atMs:NaN,intervalMs:999}],1000);
 assert.equal(value.callbacks,1);assert.equal(value.callbacksPerSecond,1);
 assert.equal(value.observedMaxIntervalMs,10);assert.equal(value.unclosedTailMs,990);
});
test('empty, zero-duration and unknown windows have explicit distinct meanings',()=>{
 assert.equal(coverage([],1000).callbacksPerSecond,0);assert.equal(coverage([],1000).unclosedTailMs,1000);
 assert.equal(coverage([],0).callbacksPerSecond,null);assert.equal(coverage([],0).unclosedTailMs,0);
 assert.equal(coverage([],null).windowMs,null);assert.equal(coverage([],-2).callbacksPerSecond,null);
});
test('a completed long interval is not relabelled as an open tail',()=>{
 const value=coverage([{atMs:100,intervalMs:100},{atMs:900,intervalMs:800}],910);
 assert.equal(value.maxObservedOrTailMs,800);assert.equal(value.unclosedTailMs,10);
});
