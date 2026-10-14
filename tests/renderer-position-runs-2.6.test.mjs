import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingRenderer} from './helpers/recording-renderer.mjs';
import {planDirtyRanges} from '../public/js/dirty-ranges.js';
function group(n=128) { const positions=new Float32Array(n*2),colors=new Uint8Array(n*4),ids=new Uint32Array(n);for(let i=0;i<n;i++){positions.set([i,0],i*2);colors.set([40,150,180,180],i*4);ids[i]=i+1;}return {kind:'points',positions,colors,ids,featureCount:n}; }
function ready(n=128){const f=createRecordingRenderer();f.renderer.setAdaptive(false);f.renderer.setOptimizationOptions({spatial:false,spatialQueryWorker:false});f.renderer.append({groups:[group(n)]});f.render();return f;}

test('position runs exactly preserve the existing planner for repeated, adjacent and scattered writes',()=>{const f=createRecordingRenderer();f.renderer.setOptimizationOptions({positionDirtyPolicy:'runs'});try {let seed=7321;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};for(let trial=0;trial<40;trial++){const page={positionDirtyRanges:[]},raw=[];for(let i=0;i<600;i++){const v=trial%3===0?i%64:trial%3===1?300:rand()%4096;f.renderer._markPositionDirty(page,v*8);raw.push([v*8,v*8+8]);}for(const gap of [0,64])for(const cap of [1,32,4096])assert.deepEqual(planDirtyRanges(page.positionDirtyRanges,{mergeGapBytes:gap,maxRanges:cap}),planDirtyRanges(raw,{mergeGapBytes:gap,maxRanges:cap}));}}finally{f.dispose();}});

test('128 repeated position API calls retain every revision but only one dirty run and an eight-byte upload',()=>{const f=ready();try{const r=f.renderer,p=r.pages.points[0];r.setOptimizationOptions({positionDirtyPolicy:'runs'});r.trackFeatures([1]);const revision=r.getCommitStats().stagingRevision;for(let i=0;i<128;i++)r.updateFeaturePositions([{id:1,x:100+i,y:20}],{summaryOnly:true});assert.equal(r.getCommitStats().stagingRevision-revision,128);assert.deepEqual(p.positionDirtyRanges,[[0,8]]);assert.equal(p.positions[0],227);const result=f.render();assert.equal(result.uploadBytes,8);assert.equal(result.uploadCalls,1);assert.equal(result.stats.stagingRevision,result.stats.committedRevision);assert.equal(p.positionDirtyRanges.length,0);}finally{f.dispose();}});

test('summaryOnly skips complete page telemetry while full responses and invalid-input atomicity remain available',()=>{const f=ready();try{const r=f.renderer;r.trackFeatures([1]);let scans=0;const stats=r.getStats.bind(r);r.getStats=()=>{scans++;return stats();};const a=r.updateFeaturePositions([{id:1,x:20,y:21}],{summaryOnly:true});const b=r.updateFeatureColors([{id:1,color:[1,2,3,4]}],{summaryOnly:true});assert.equal(scans,0);assert.equal(a.updated,1);assert.equal(b.updatedVertices,1);assert.ok(Number.isInteger(a.revision));assert.equal(b.revision,a.revision+1);const full=r.updateFeaturePositions([{id:1,x:22,y:23}]);assert.equal(scans,1);assert.ok(full.optimization);const before=r.getCommitStats().stagingRevision,xy=Array.from(r.pages.points[0].positions.slice(0,2));assert.throws(()=>r.updateFeaturePositions([{id:1,x:9,y:9}],{summaryOnly:'yes'}));assert.throws(()=>r.updateFeatureColors([{id:1,color:[9,9,9,9]}],{summaryOnly:null}));assert.equal(r.getCommitStats().stagingRevision,before);assert.deepEqual(Array.from(r.pages.points[0].positions.slice(0,2)),xy);}finally{f.dispose();}});

test('position runs support a shared ID across pages without changing GPU slots',()=>{const f=createRecordingRenderer();try{const g=group(65540);g.ids.fill(17);const r=f.renderer;r.setAdaptive(false);r.setOptimizationOptions({spatial:false,spatialQueryWorker:false});r.append({groups:[g]});r.trackFeatures([17]);f.render();const result=r.updateFeaturePositions([{id:17,x:3,y:4}],{summaryOnly:true});assert.equal(result.updated,1);assert.deepEqual(r.pages.points.map(p=>p.positionDirtyRanges),[[[0,65535*8]],[[0,5*8]]]);const frame=f.render();assert.equal(frame.uploadBytes,65540*8);assert.equal(frame.uploadCalls,2);for(const p of r.pages.points)for(let i=0;i<p.count;i++){assert.equal(p.positions[i*2],3);assert.equal(p.positions[i*2+1],4);}}finally{f.dispose();}});

test('reentrant position edits during GL submission remain dirty and are acknowledged only after another submission',()=>{const f=ready();try{const r=f.renderer,p=r.pages.points[0];r.setOptimizationOptions({positionDirtyPolicy:'runs'});r.trackFeatures([1,2]);r.updateFeaturePositions([{id:1,x:20,y:20}],{summaryOnly:true});const submit=f.gl.bufferSubData.bind(f.gl);let injected=false;f.gl.bufferSubData=(target,offset,data)=>{submit(target,offset,data);if(!injected&&f.gl.bindings[target]===p.gpu.position){injected=true;r.updateFeaturePositions([{id:2,x:30,y:30}],{summaryOnly:true});}};r._upload(p);assert.ok(r.getCommitStats().committedRevision<r.getCommitStats().stagingRevision);assert.deepEqual(p.positionDirtyRanges,[[0,16]]);const next=f.render();assert.equal(next.uploadBytes,16);assert.equal(next.stats.committedRevision,next.stats.stagingRevision);}finally{f.dispose();}});

test('binding runs keep exact unchanged gaps and append-tail ownership',()=>{
 const f=createRecordingRenderer();try{
  const r=f.renderer;r.setAdaptive(false);r.setOptimizationOptions({spatial:false,spatialQueryWorker:false,positionDirtyPolicy:'binding-runs'});
  const g=group(6);g.ids.fill(7);g.positions.set([0,0,9,9,2,0,9,9,4,0,5,0]);r.append({groups:[g]});r.trackFeatures([7]);f.render();
  const tail=group(2);tail.ids.fill(7);r.append({groups:[tail]});
  r.updateFeaturePositions([{id:7,x:9,y:9}],{summaryOnly:true});
  const p=r.pages.points[0];assert.deepEqual(p.positionDirtyRanges,[[0,8],[16,24],[32,48]]);
  const result=f.render();assert.equal(result.stats.committedRevision,result.stats.stagingRevision);
  for(let i=0;i<8;i++)assert.deepEqual(Array.from(p.positions.slice(i*2,i*2+2)),[9,9]);
 }finally{f.dispose();}
});

test('summary position batches reject a bad final record before any valid prefix mutation',()=>{
 const f=ready();try{
  const r=f.renderer;r.trackFeatures([1,2]);const p=r.pages.points[0], before=Array.from(p.positions.slice(0,4)),rev=r.getCommitStats().stagingRevision;
  for(const invalid of [{id:2,x:NaN,y:0},{id:-1,x:1,y:1}])assert.throws(()=>r.updateFeaturePositions([{id:1,x:90,y:91},invalid],{summaryOnly:true}));
  assert.deepEqual(Array.from(p.positions.slice(0,4)),before);assert.equal(r.getCommitStats().stagingRevision,rev);assert.equal(p.positionDirtyRanges.length,0);
 }finally{f.dispose();}
});
