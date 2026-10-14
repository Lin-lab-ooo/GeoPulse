import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {attachStreamWriteTrace,auditFirstDrawBeforeLaterWrite} from '../tools/server-write-trace-2.6.mjs';
const make=({write=1150,mode='fixed',upper=3,lower=1}={})=>({
 trace:{droppedWrites:0,streams:[{parameters:{count:'100',seed:'7',chunk:'100',delay:'8',compression:'identity'},finishEpochMs:1200,writes:[{serverEpochMs:write}]}]},
 clockBefore:{samples:[{offsetLowerMs:lower,offsetUpperMs:upper}]},clockAfter:{samples:[{offsetLowerMs:lower,offsetUpperMs:upper}]},
 browserTimeOrigin:1000,runs:[{config:{count:100,seed:7,chunk:100,delay:8,compression:'identity',mode},loadingExperiment:{startedMonotonicMs:0,firstBusinessDrawMs:100,trial:{trialId:'t'}}}]
});
test('source progression proof uses worst-case offset and does not treat boundary equality as later',()=>{
 assert.equal(auditFirstDrawBeforeLaterWrite(make()).streamingProven,1);
 assert.equal(auditFirstDrawBeforeLaterWrite(make({write:1104})).streamingProven,0);
 assert.equal(auditFirstDrawBeforeLaterWrite(make({write:1105})).streamingProven,1);
 assert.equal(auditFirstDrawBeforeLaterWrite(make({write:1000,mode:'baseline'})).baselineProgressive,0);
});
test('source progression audit rejects truncated, misordered and conflicting-clock evidence',()=>{
 const short=make();short.trace.droppedWrites=1;assert.throws(()=>auditFirstDrawBeforeLaterWrite(short),/truncated/);
 const mismatch=make();mismatch.runs[0].config.seed=8;assert.throws(()=>auditFirstDrawBeforeLaterWrite(mismatch),/material\/transport mismatch/);
 const clocks=make();clocks.clockAfter.samples[0]={offsetLowerMs:20,offsetUpperMs:23};assert.throws(()=>auditFirstDrawBeforeLaterWrite(clocks),/bounds conflict/);
});
test('response tracing forwards each write/end once and preserves false backpressure',()=>{
 const server=new EventEmitter(),trace=attachStreamWriteTrace(server,{maximumWrites:1});
 const response=new EventEmitter();const calls=[];
 response.write=function(...args){calls.push(['write',...args]);return false;};
 response.end=function(...args){calls.push(['end',...args]);return this;};
 server.emit('request',{url:'/api/stream?count=1&seed=7',method:'GET',headers:{}},response);
 const callback=()=>{};
 assert.equal(response.write('first','utf8',callback),false);
 assert.equal(response.end('last',callback),response);
 response.emit('finish');response.emit('close');
 const result=trace.snapshot();
 assert.deepEqual(calls,[['write','first','utf8',callback],['end','last',callback]]);
 assert.equal(result.observedWrites,2);assert.equal(result.droppedWrites,1);
 assert.equal(result.streams[0].writes[0].accepted,false);
 assert.ok(result.streams[0].finishEpochMs);assert.ok(result.streams[0].closeEpochMs);
 trace.dispose();assert.equal(server.listenerCount('request'),0);
});
