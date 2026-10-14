/** 2.4 dynamic lifecycle correctness. Recording GL proves submissions, not rasterization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';
const NORMAL=[20,130,220,180],ALERT=[255,70,30,173],PULSE_ONLY=[255,250,122,67];
const A={x:100,y:100,scale:6,heading:0},B={x:900,y:900,scale:6,heading:0};
const SIZES={points:1,lines:2,polygons:3};
function group(kind='points',count=2000,firstID=1,color=()=>NORMAL){
  const size=SIZES[kind],positions=new Float32Array(count*size*2),colors=new Uint8Array(count*size*4),ids=new Uint32Array(count*size);
  for(let i=0;i<count;i++){
    const c=i%2?900:100,xy=size===1?[c,c]:size===2?[c-10,c-10,c+10,c+10]:[c-10,c-10,c+10,c-10,c,c+10];positions.set(xy,i*size*2);
    for(let v=0;v<size;v++){colors.set(color(i,v),(i*size+v)*4);ids[i*size+v]=firstID+i;}
  }
  return{kind,positions,colors,ids,featureCount:count};
}
function fixture(options={}){const f=createRecordingRenderer();f.renderer.setAdaptive(false);f.renderer.setOptimizationOptions({spatialQueryWorker:false,spatialBuildExecution:'synchronous',spatialPolicy:'always',maxCandidateRatio:1,...options});return f;}
const rgba=(page,vertex)=>Array.from(page.colors.subarray(vertex*4,vertex*4+4));
const xy=(page,vertex)=>Array.from(page.positions.subarray(vertex*2,vertex*2+2));
const selected=page=>Array.from(page.indices?.subarray(0,page.indexCount)??[]);
const positionBytes=frame=>frame.uploads.filter(u=>u.channel==='position').reduce((n,u)=>n+u.byteLength,0);

test('moved feature survives remove and restore at its current viewport with exact alpha',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.render(A);const page=f.renderer.pages.points[0],tree=page.spatial,original=rgba(page,0);
    f.renderer.updateFeaturePositions([{id:1,x:905,y:905}]);f.render(B);assert.ok(selected(page).includes(0));
    f.renderer.removeFeatures([1]);f.render(B);assert.ok(!selected(page).includes(0));assert.equal(page.colors[3],0);
    assert.equal(f.renderer.restoreFeatures([1]).restored,1);const restored=f.render(B);
    assert.ok(selected(page).includes(0));assert.deepEqual(xy(page,0),[905,905]);assert.deepEqual(rgba(page,0),original);assert.equal(page.spatial,tree,'one lifecycle does not rebuild the base tree');
    assert.equal(restored.colorUploadBytes,4);assert.equal(positionBytes(restored),0);assert.equal(f.renderer.getOverlay().removed,0);assert.equal(f.renderer.getOverlay().moved,1);
  }finally{f.dispose();}
});

test('moving outside the entire original page bbox remains drawable and expands the conservative page bound',()=>{
  const f=fixture();try{
    const data=group('points',1000);for(let i=0;i<data.positions.length;i++)data.positions[i]=100;f.renderer.append({groups:[data]});f.renderer.trackFeatures([1]);f.render(A);
    const page=f.renderer.pages.points[0];assert.equal(page.maxX,100);f.renderer.updateFeaturePositions([{id:1,x:905,y:905}]);const moved=f.render(B);
    assert.ok(page.maxX>=905&&page.maxY>=905);assert.ok(moved.submittedVertices>0);assert.ok(selected(page).includes(0));
    f.renderer.removeFeatures([1]);f.render(B);f.renderer.restoreFeatures([1]);const restored=f.render(B);assert.ok(restored.submittedVertices>0);assert.ok(selected(page).includes(0));
  }finally{f.dispose();}
});

test('restore preserves all four bytes including partial and zero alpha',()=>{
  const f=fixture();try{
    const values=[[30,80,160,33],[40,90,170,0],[255,70,30,173]];f.renderer.append({groups:[group('points',2000,1,i=>values[i%3])]});f.renderer.trackFeatures([1,2,3]);f.render(A);const page=f.renderer.pages.points[0],before=[0,1,2].map(v=>rgba(page,v));
    f.renderer.removeFeatures([1,2,3]);f.render(A);f.renderer.restoreFeatures([1,2,3]);f.render(A);assert.deepEqual([0,1,2].map(v=>rgba(page,v)),before);
  }finally{f.dispose();}
});

test('deleted features ignore ordinary color and position writes without becoming visible or incrementing revisions',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.renderer.updateFeaturePositions([{id:1,x:905,y:905}]);f.render(B);const page=f.renderer.pages.points[0],before=rgba(page,0);
    f.renderer.removeFeatures([1]);f.render(B);const revision=f.renderer.getStats().stagingRevision;
    const colors=f.renderer.updateFeatureColors([{id:1,color:[255,0,0,255]}]),positions=f.renderer.updateFeaturePositions([{id:1,x:100,y:100}]);
    assert.equal(colors.updated,0);assert.equal(colors.ignored,1);assert.equal(positions.updated,0);assert.equal(positions.ignored,1);assert.equal(f.renderer.getStats().stagingRevision,revision);assert.equal(page.colors[3],0);assert.deepEqual(xy(page,0),[905,905]);
    const inactive=f.render(B);assert.equal(inactive.colorUploadBytes,0);assert.equal(positionBytes(inactive),0);assert.ok(!selected(page).includes(0));
    f.renderer.restoreFeatures([1]);f.render(B);assert.deepEqual(rgba(page,0),before);assert.ok(selected(page).includes(0));
    assert.equal(f.renderer.updateFeatureColors([{id:1,color:[50,160,210,71]}]).updated,1);f.render(B);assert.deepEqual(rgba(page,0),[50,160,210,71]);
  }finally{f.dispose();}
});

test('duplicate deletion and restoration IDs are idempotent across repeated lifecycle cycles',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group('points',2000,1,i=>i===0?ALERT:NORMAL)]});f.renderer.trackFeatures([1]);f.render(A);const page=f.renderer.pages.points[0];
    for(let round=0;round<3;round++){
      const removed=f.renderer.removeFeatures([1,1,1]);assert.equal(removed.removed,1);assert.equal(f.renderer.removeFeatures([1]).removed,0);f.render(A);assert.equal(f.renderer.getStats().pointAlertsTotal,0);
      const restored=f.renderer.restoreFeatures([1,1,1]);assert.equal(restored.restored,1);assert.equal(f.renderer.restoreFeatures([1]).restored,0);f.render(A);assert.deepEqual(rgba(page,0),ALERT);assert.equal(f.renderer.getStats().pointAlertsTotal,1);assert.equal(page.pointAlertCount,1);assert.equal(page.pointPulseCount,1);
    }
  }finally{f.dispose();}
});

test('point, line and triangle features restore complete primitive slots and distinct per-vertex RGBA',()=>{
  for(const kind of Object.keys(SIZES)){
    const f=fixture();try{
      const size=SIZES[kind],color=(_i,v)=>[20+v*10,100+v*10,170+v*10,60+v*40];f.renderer.append({groups:[group(kind,2000,1,color)]});f.renderer.trackFeatures([1]);f.render(A);const page=f.renderer.pages[kind][0],vertices=Array.from({length:size},(_,i)=>i),saved=vertices.map(v=>rgba(page,v));
      assert.ok(vertices.every(v=>selected(page).includes(v)));f.renderer.removeFeatures([1]);f.render(A);assert.ok(vertices.every(v=>!selected(page).includes(v)));assert.ok(vertices.every(v=>page.colors[v*4+3]===0));
      f.renderer.restoreFeatures([1]);f.render(A);assert.ok(vertices.every(v=>selected(page).includes(v)));assert.deepEqual(vertices.map(v=>rgba(page,v)),saved);assert.equal(page.indexCount%size,0);
    }finally{f.dispose();}
  }
});

test('removal and restore adjust dense alert and shader-pulse counters without a phantom animation',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group('points',2000,1,i=>i===0?ALERT:i===1?PULSE_ONLY:NORMAL)]});f.renderer.trackFeatures([1,2]);const wide={x:500,y:500,scale:.5,heading:0};let frame=f.render(wide);const page=f.renderer.pages.points[0];
    assert.equal(page.pointAlertCount,1);assert.equal(page.pointPulseCount,2);assert.equal(frame.stats.pointAlertsTotal,1);assert.equal(frame.stats.renderScheduling.pulseActive,true);
    f.renderer.removeFeatures([1,2]);frame=f.render(wide);assert.equal(page.pointAlertCount,0);assert.equal(page.pointPulseCount,0);assert.equal(frame.stats.pointAlertsTotal,0);assert.equal(frame.stats.pointAlertsDrawn,0);assert.equal(frame.stats.renderScheduling.pulseActive,false);
    f.renderer.restoreFeatures([1,2]);frame=f.render(wide);assert.equal(page.pointAlertCount,1);assert.equal(page.pointPulseCount,2);assert.equal(frame.stats.pointAlertsTotal,1);assert.equal(frame.stats.pointAlertsDrawn,1);assert.equal(frame.stats.renderScheduling.pulseActive,true);assert.deepEqual(rgba(page,0),ALERT);assert.deepEqual(rgba(page,1),PULSE_ONLY);
  }finally{f.dispose();}
});

test('a single ID bound across two pages retains every current position and per-binding color',()=>{
  const f=fixture();try{
    const data=group('points',67535,1000);data.ids[0]=42;data.ids[65545]=42;data.positions.set([100,100],0);data.positions.set([100,100],65545*2);data.colors.set([30,90,170,31],0);data.colors.set([40,100,180,77],65545*4);
    f.renderer.append({groups:[data]});assert.equal(f.renderer.trackFeatures([42]).bound,1);f.render(A);const pages=f.renderer.pages.points,targets=[[pages[0],0],[pages[1],10]],saved=targets.map(([p,v])=>rgba(p,v));assert.equal(pages.length,2);
    f.renderer.updateFeaturePositions([{id:42,x:905,y:905}]);f.render(B);assert.ok(targets.every(([p,v])=>selected(p).includes(v)));
    f.renderer.removeFeatures([42]);f.render(B);assert.ok(targets.every(([p,v])=>!selected(p).includes(v)));f.renderer.restoreFeatures([42]);f.render(B);
    assert.deepEqual(targets.map(([p,v])=>rgba(p,v)),saved);assert.ok(targets.every(([p,v])=>selected(p).includes(v)));assert.ok(targets.every(([p,v])=>xy(p,v).every(x=>x===905)));
  }finally{f.dispose();}
});

test('restore validates all IDs before changing any valid tombstone',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.renderer.removeFeatures([1]);f.render(A);const page=f.renderer.pages.points[0],revision=f.renderer.getStats().stagingRevision;
    for(const invalid of [-1,1.5,4294967296,NaN]){assert.throws(()=>f.renderer.restoreFeatures([1,invalid]));assert.equal(f.renderer.getStats().stagingRevision,revision);assert.equal(f.renderer.getOverlay().removed,1);assert.equal(page.colors[3],0);}
    assert.equal(f.renderer.restoreFeatures([1]).restored,1);f.render(A);assert.deepEqual(rgba(page,0),NORMAL);
  }finally{f.dispose();}
});

test('Float32 overflow is atomically rejected before any valid position in the batch is changed',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1,2]);f.render(A);const page=f.renderer.pages.points[0],first=xy(page,0),second=xy(page,1),revision=f.renderer.getStats().stagingRevision;
    assert.throws(()=>f.renderer.updateFeaturePositions([{id:1,x:105,y:105},{id:2,x:1e39,y:0}]));assert.deepEqual(xy(page,0),first);assert.deepEqual(xy(page,1),second);assert.equal(f.renderer.getStats().stagingRevision,revision);assert.equal(f.renderer.getOverlay().moved,0);
  }finally{f.dispose();}
});

test('decimal coordinates compare in Float32 space and duplicate positions use only the final ID state',()=>{
  const f=fixture();try{
    const data=group();data.positions.set([.1,.2],0);f.renderer.append({groups:[data]});f.renderer.trackFeatures([1]);f.render(A);const page=f.renderer.pages.points[0],revision=f.renderer.getStats().stagingRevision;
    const noop=f.renderer.updateFeaturePositions([{id:1,x:.1,y:.2}]);assert.equal(noop.updated,0);assert.equal(noop.unchanged,1);assert.equal(noop.revision,revision);assert.equal(f.renderer.getOverlay().moved,0);
    const changed=f.renderer.updateFeaturePositions([{id:1,x:.9,y:.8},{id:1,x:.3,y:.4}]);assert.equal(changed.updated,1);assert.deepEqual(xy(page,0),[Math.fround(.3),Math.fround(.4)]);assert.equal(f.renderer.getOverlay().positionUpdates,1);
    const repeated=f.renderer.updateFeaturePositions([{id:1,x:.3,y:.4}]);assert.equal(repeated.updated,0);assert.equal(repeated.unchanged,1);assert.equal(repeated.revision,changed.revision);f.render(A);assert.equal(f.render(A).uploadBytes,0);
  }finally{f.dispose();}
});

test('reset discards old tombstones, movement snapshots and pending ordinary updates',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.renderer.updateFeaturePositions([{id:1,x:905,y:905}]);f.renderer.removeFeatures([1]);f.renderer._updateQueue.offer({id:1,color:ALERT,at:1});f.renderer.reset();
    assert.equal(f.renderer.getOverlay().removed,0);assert.equal(f.renderer.getOverlay().moved,0);assert.equal(f.renderer.getStats().updateQueue.backlog,0);assert.equal(f.renderer.restoreFeatures([1]).restored,0);
    const replacement=group('points',2000,1,i=>i===0?[41,111,191,99]:NORMAL);f.renderer.append({groups:[replacement]});f.renderer.trackFeatures([1]);f.render(A);const page=f.renderer.pages.points[0];assert.deepEqual(rgba(page,0),[41,111,191,99]);assert.deepEqual(xy(page,0),[100,100]);assert.ok(selected(page).includes(0));
  }finally{f.dispose();}
});
test('append of an already deleted ID stays tombstoned and restores old and new binding RGBA exactly',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.renderer.updateFeaturePositions([{id:1,x:905,y:905}]);f.render(B);const page=f.renderer.pages.points[0],original=rgba(page,0);
    f.renderer.removeFeatures([1]);f.render(B);const tail=group('points',10,5000);tail.ids[0]=1;tail.positions.set([905,905],0);tail.colors.set([255,70,30,123],0);
    f.renderer.append({groups:[tail]});f.render(B);assert.equal(page.colors[2000*4+3],0);assert.ok(!selected(page).includes(0));assert.ok(!selected(page).includes(2000));assert.equal(f.renderer.getStats().pointAlertsTotal,0);assert.equal(page.pointPulseCount,0);
    f.renderer.restoreFeatures([1]);const restored=f.render(B);assert.deepEqual(rgba(page,0),original);assert.deepEqual(rgba(page,2000),[255,70,30,123]);assert.ok(selected(page).includes(0));assert.ok(selected(page).includes(2000));assert.equal(restored.stats.pointAlertsTotal,1);assert.equal(page.pointAlertCount,1);assert.equal(page.pointPulseCount,1);
  }finally{f.dispose();}
});

test('deleted IDs remain tombstoned through unsubscribe, append and resubscribe before restoration',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[group()]});f.renderer.trackFeatures([1]);f.renderer.removeFeatures([1]);f.render(A);f.renderer.trackFeatures([]);
    const tail=group('points',10,7000);tail.ids[0]=1;tail.positions.set([100,100],0);tail.colors.set([35,135,225,29],0);f.renderer.append({groups:[tail]});f.render(A);const page=f.renderer.pages.points[0];assert.equal(page.colors[2000*4+3],0);
    f.renderer.trackFeatures([1]);assert.equal(f.renderer.restoreFeatures([1]).restored,1);f.render(A);assert.deepEqual(rgba(page,0),NORMAL);assert.deepEqual(rgba(page,2000),[35,135,225,29]);assert.ok(selected(page).includes(0));assert.ok(selected(page).includes(2000));
  }finally{f.dispose();}
});