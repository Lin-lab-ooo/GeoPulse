// Pure/offline regression cases. Prepared while the native exclusive window is occupied; run later.
import test from 'node:test';
import assert from 'node:assert/strict';
import {identityWriteBudget,auditFirstDrawBeforeLaterWrite} from '../tools/server-write-trace-2.6.mjs';

const fixture=()=>({
 browserTimeOrigin:1000,
 clockBefore:{samples:[{browserBeforeEpochMs:900,browserAfterEpochMs:902,serverEpochMs:908,offsetLowerMs:6,offsetUpperMs:8}]},
 clockAfter:{samples:[{browserBeforeEpochMs:2000,browserAfterEpochMs:2002,serverEpochMs:2008,offsetLowerMs:6,offsetUpperMs:8}]},
 trace:{droppedWrites:0,streams:[
  {parameters:{count:'2',seed:'42',chunk:'1',delay:'8',compression:'identity'},finishEpochMs:1407,writes:[{serverEpochMs:1107,length:100},{serverEpochMs:1307,length:100}]},
  {parameters:{count:'2',seed:'42',chunk:'1',delay:'8',compression:'identity'},finishEpochMs:1557,writes:[{serverEpochMs:1457,length:100},{serverEpochMs:1507,length:100}]}
 ]},
 runs:[
  {config:{count:2,seed:42,chunk:1,delay:8,compression:'identity',mode:'fixed'},loadingExperiment:{startedMonotonicMs:100,firstBusinessDrawMs:100,trial:{trialId:'streaming'}}},
  {config:{count:2,seed:42,chunk:1,delay:8,compression:'identity',mode:'baseline'},loadingExperiment:{startedMonotonicMs:400,firstBusinessDrawMs:200,trial:{trialId:'baseline'}}}
 ]
});

test('default formal identity write budget is below capacity',()=>{
 const result=identityWriteBudget({sizes:[100000,1000000],expectedRuns:30,chunk:1024,compression:'identity'});
 assert.equal(result.expectedWrites,16125);assert.equal(result.maximumWrites,50000);
});
test('formal chunk 256 is rejected before launching a browser',()=>{
 assert.throws(()=>identityWriteBudget({sizes:[100000,1000000],expectedRuns:30,chunk:256,compression:'identity'}),/64470/);
});
test('smoke budget is exactly 600 identity writes',()=>{
 assert.equal(identityWriteBudget({sizes:[10000],expectedRuns:15,chunk:256,compression:'identity'}).expectedWrites,600);
});
test('gzip cannot stand in for later business record writes',()=>{
 assert.throws(()=>identityWriteBudget({sizes:[10000],expectedRuns:15,chunk:256,compression:'gzip'}),/requires identity/);
 const value=fixture();value.trace.streams[0].parameters.compression='gzip';value.runs[0].config.compression='gzip';
 assert.throws(()=>auditFirstDrawBeforeLaterWrite(value),/requires identity/);
});
test('clock conversion proves later streaming write, not baseline',()=>{
 const proof=auditFirstDrawBeforeLaterWrite(fixture());
 assert.equal(proof.streamingTrials,1);assert.equal(proof.streamingProven,1);assert.equal(proof.baselineProgressive,0);
 assert.equal(proof.rows[0].firstDrawEpochMs,1200);assert.equal(proof.rows[0].firstProvenLaterWriteBrowserLowerEpochMs,1298);
});
test('complete identity transport must match the recorded run',()=>{
 for(const key of ['count','seed','chunk','delay']){const value=fixture();value.trace.streams[0].parameters[key]=String(Number(value.trace.streams[0].parameters[key])+1);assert.throws(()=>auditFirstDrawBeforeLaterWrite(value),/material\/transport mismatch/);}
});
test('missing or truncated nonempty write evidence is rejected',()=>{
 const dropped=fixture();dropped.trace.droppedWrites=1;assert.throws(()=>auditFirstDrawBeforeLaterWrite(dropped),/truncated/);
 const missing=fixture();missing.trace.streams[0].writes.pop();assert.throws(()=>auditFirstDrawBeforeLaterWrite(missing),/write count mismatch/);
});
test('an unbounded or inconsistent clock cannot prove progression',()=>{
 const missing=fixture();missing.browserTimeOrigin=null;assert.throws(()=>auditFirstDrawBeforeLaterWrite(missing),/time origin/);
 const conflict=fixture();conflict.clockAfter.samples[0].offsetLowerMs=20;conflict.clockAfter.samples[0].offsetUpperMs=22;
 assert.throws(()=>auditFirstDrawBeforeLaterWrite(conflict),/bounds conflict/);
});
