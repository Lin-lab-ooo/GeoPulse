/** Adversarial synchronous GL adapter re-entry, not a claim about native GL callbacks.
 * A shadow copy records bytes submitted before callbacks mutate CPU page arrays. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingRenderer} from './helpers/recording-renderer.mjs';
const BASE=[20,130,220,173],NEW=[90,220,120,200];
function data(n,first=1,x=10){const positions=new Float32Array(n*2),colors=new Uint8Array(n*4),ids=new Uint32Array(n);for(let i=0;i<n;i++){positions.set([x+i,10],i*2);colors.set(BASE,i*4);ids[i]=first+i;}return{groups:[{kind:'points',positions,colors,ids,featureCount:n}]};}
function fixture(initialUploaded=true,policy='accumulator'){const f=createRecordingRenderer(),r=f.renderer;r.setAdaptive(false);r.setOptimizationOptions({spatial:false,colorUploadPolicy:policy});r.append(data(4));if(initialUploaded)f.render();else r._useContext(f.gl);return f;}
function installShadow(f,page,hook){
 const buffers=new Map(),submit=f.gl.bufferSubData.bind(f.gl);let injected=false;
 // Already committed prefix is initialized from its known submitted bytes.
 if(page.gpu&&page.uploaded){const position=new Uint8Array(page.gpu.position.byteLength),color=new Uint8Array(page.gpu.color.byteLength);position.set(new Uint8Array(page.positions.buffer,0,page.uploaded*8));color.set(page.colors.subarray(0,page.uploaded*4));buffers.set(page.gpu.position,position);buffers.set(page.gpu.color,color);}
 f.gl.bufferSubData=(target,offset,view)=>{
  const buffer=f.gl.bindings[target],copy=new Uint8Array(view.buffer,view.byteOffset,view.byteLength).slice();
  if(!buffers.has(buffer))buffers.set(buffer,new Uint8Array(buffer.byteLength));buffers.get(buffer).set(copy,offset);
  const result=submit(target,offset,view);
  if(!injected&&hook({buffer,offset,bytes:view.byteLength,position:buffer===page.gpu.position,color:buffer===page.gpu.color})){injected=true;}
  return result;
 };
 return{buffers,get injected(){return injected;},rgba(vertex){return Array.from(buffers.get(page.gpu.color).subarray(vertex*4,vertex*4+4));},xy(vertex){const bytes=buffers.get(page.gpu.position);return Array.from(new Float32Array(bytes.buffer,vertex*8,2));}};
}
function assertPendingOrCurrent(f,shadow,actual,expected){assert.ok(actual.every((v,i)=>v===expected[i])||f.renderer.getCommitStats().pendingGeometryPages>0,'a CPU state newer than submitted GL bytes must remain pending');assert.equal(shadow.injected,true);}

test('first upload from zero retains a color mutation made after its full color submission',()=>{
 for(const policy of ['legacy','density','accumulator']){const f=fixture(false,policy);try{const r=f.renderer,page=r.pages.points[0];r.trackFeatures([1]);const shadow=installShadow(f,page,event=>{if(!event.color)return false;r.updateFeatureColors([{id:1,color:NEW}]);return true;});
  r._upload(page);assertPendingOrCurrent(f,shadow,shadow.rgba(0),NEW);f.render();assert.deepEqual(shadow.rgba(0),NEW);assert.equal(r.getCommitStats().pendingGeometryPages,0);assert.equal(r.getStats().committedRevision,r.getStats().stagingRevision);
 }finally{f.dispose();}}
});

test('append-tail color mutation after the tail copy cannot be cleared by an old-prefix token',()=>{
 for(const policy of ['legacy','density','accumulator']){const f=fixture(true,policy);try{const r=f.renderer,page=r.pages.points[0];r.trackFeatures([5]);r.append(data(4,5));const shadow=installShadow(f,page,event=>{if(!event.color||event.offset!==16)return false;r.updateFeatureColors([{id:5,color:NEW}]);return true;});
  r._upload(page);assertPendingOrCurrent(f,shadow,shadow.rgba(4),NEW);f.render();assert.deepEqual(shadow.rgba(4),NEW);assert.equal(r.getCommitStats().pendingGeometryPages,0);assert.equal(r.getStats().committedRevision,r.getStats().stagingRevision);
 }finally{f.dispose();}}
});

test('position generation changed after an old-prefix position submission stays queued for retry',()=>{
 for(const policy of ['legacy','density','accumulator']){const f=fixture(true,policy);try{const r=f.renderer,page=r.pages.points[0];r.trackFeatures([1]);r.updateFeaturePositions([{id:1,x:200,y:200}]);const shadow=installShadow(f,page,event=>{if(!event.position)return false;r.updateFeaturePositions([{id:1,x:300,y:300}]);return true;});
  r._upload(page);assertPendingOrCurrent(f,shadow,shadow.xy(0),[300,300]);f.render();assert.deepEqual(shadow.xy(0),[300,300]);assert.equal(page.positionDirtyRanges.length,0);assert.equal(r.getCommitStats().pendingGeometryPages,0);
 }finally{f.dispose();}}
});

test('first upload from zero retains a position change made after initial position submission',()=>{
 for(const policy of ['legacy','density','accumulator']){const f=fixture(false,policy);try{const r=f.renderer,page=r.pages.points[0];r.trackFeatures([1]);const shadow=installShadow(f,page,event=>{if(!event.position)return false;r.updateFeaturePositions([{id:1,x:300,y:300}]);return true;});
  r._upload(page);assertPendingOrCurrent(f,shadow,shadow.xy(0),[300,300]);f.render();assert.deepEqual(shadow.xy(0),[300,300]);assert.equal(r.getCommitStats().pendingGeometryPages,0);assert.equal(r.getStats().committedRevision,r.getStats().stagingRevision);
 }finally{f.dispose();}}
});

test('append during tail-position submission advances only the entry target watermark',()=>{
 for(const policy of ['legacy','density','accumulator']){const f=fixture(true,policy);try{const r=f.renderer,page=r.pages.points[0];r.append(data(4,5));const shadow=installShadow(f,page,event=>{if(!event.position||event.offset!==32)return false;r.append(data(4,9,100));return true;});
  r._upload(page);assert.equal(shadow.injected,true);assert.equal(page.count,12);
  assert.ok(page.uploaded<=8||r.getCommitStats().pendingGeometryPages>0,'positions for appended-after-entry vertices were never submitted but must not become clean');
  f.render();for(let v=8;v<12;v++)assert.deepEqual(shadow.xy(v),[100+v-8,10]);assert.equal(page.uploaded,12);assert.equal(r.getCommitStats().pendingGeometryPages,0);assert.equal(r.getStats().committedRevision,r.getStats().stagingRevision);
 }finally{f.dispose();}}
});
test('hidden-layer GL re-entry cannot ACK the newest revision before its bytes are submitted',async()=>{
 for(const policy of ['legacy','density','accumulator']){
  const f=fixture(true,policy);let pending;try{
   const r=f.renderer,page=r.pages.points[0];r.trackFeatures([5]);r.setLayers({points:false});r.append(data(4,5));
   const shadow=installShadow(f,page,event=>{if(!event.color||event.offset!==16)return false;r.updateFeatureColors([{id:5,color:NEW}]);return true;});
   const interrupted=f.render();assert.equal(shadow.injected,true);assert.equal(interrupted.drawCalls,0);assert.ok(interrupted.stats.committedRevision<interrupted.stats.stagingRevision);assert.ok(r.getCommitStats().pendingGeometryPages>0);
   let resolved=false;pending=r.awaitCommit(interrupted.stats.stagingRevision).then(stats=>{resolved=true;return stats;});pending.catch(()=>{});await Promise.resolve();assert.equal(resolved,false);
   const replayed=f.render();assert.equal(replayed.drawCalls,0);assert.deepEqual(shadow.rgba(4),NEW);assert.equal(r.getCommitStats().pendingGeometryPages,0);assert.equal((await pending).committedRevision,replayed.stats.stagingRevision);
  }finally{f.dispose();if(pending)await pending.catch(()=>{});}
 }
});

test('tail-color submission failure keeps old prefix marks and the append watermark for both-channel retry',()=>{
 for(const policy of ['legacy','density','accumulator']){
  const f=fixture(true,policy);try{
   const r=f.renderer,page=r.pages.points[0];r.trackFeatures([1]);const shadow=installShadow(f,page,()=>false);r.updateFeatureColors([{id:1,color:NEW}]);r.append(data(4,5));
   const submit=f.gl.bufferSubData.bind(f.gl);let fail=true;f.gl.bufferSubData=(target,offset,bytes)=>{if(fail&&f.gl.bindings[target]===page.gpu.color&&offset===16){fail=false;throw new Error('tail-color injected failure');}return submit(target,offset,bytes);};
   assert.throws(()=>r._upload(page),/tail-color injected failure/);assert.equal(page.uploaded,4);assert.ok(r.getCommitStats().pendingGeometryPages>0);r._upload(page);f.render();
   assert.deepEqual(shadow.rgba(0),NEW);assert.deepEqual(shadow.rgba(4),BASE);assert.deepEqual(shadow.xy(4),[10,10]);assert.equal(page.uploaded,8);assert.equal(r.getCommitStats().pendingGeometryPages,0);
  }finally{f.dispose();}
 }
});

test('prefix-position failure after successful color keeps both dirty channels recoverable',()=>{
 for(const policy of ['legacy','density','accumulator']){
  const f=fixture(true,policy);try{
   const r=f.renderer,page=r.pages.points[0];r.trackFeatures([1]);const shadow=installShadow(f,page,()=>false);r.updateFeatureColors([{id:1,color:NEW}]);r.updateFeaturePositions([{id:1,x:200,y:200}]);
   const submit=f.gl.bufferSubData.bind(f.gl);let fail=true;f.gl.bufferSubData=(target,offset,bytes)=>{if(fail&&f.gl.bindings[target]===page.gpu.position){fail=false;throw new Error('prefix-position injected failure');}return submit(target,offset,bytes);};
   assert.throws(()=>r._upload(page),/prefix-position injected failure/);assert.ok(r.getCommitStats().pendingGeometryPages>0);assert.ok(page.positionDirtyRanges.length>0);r._upload(page);f.render();
   assert.deepEqual(shadow.rgba(0),NEW);assert.deepEqual(shadow.xy(0),[200,200]);assert.equal(page.positionDirtyRanges.length,0);assert.equal(r.getCommitStats().pendingGeometryPages,0);
  }finally{f.dispose();}
 }
});