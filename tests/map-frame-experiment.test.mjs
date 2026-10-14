import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeMapFrames,mapExperimentView,summarizeMapUploads,mapCameraPoseMatches,MAP_FRAME_METHODS,
  summarizeBuildPreparation,spatialPreparationReady} from '../public/js/map-frame-experiment.js';

test('callback summary derives its budget from actual foreground cadence',()=>{
  const summary=summarizeMapFrames([4,4,8,NaN,Infinity],4);
  assert.equal(summary.samples,3);assert.equal(summary.fpsMean,187.5);
  assert.equal(summary.p95Ms,8);assert.equal(summary.p99Ms,8);
  assert.equal(summary.slowThresholdMs,6);assert.equal(summary.slowFrames,1);
});
test('missing callback samples stay unknown rather than becoming zero FPS',()=>{
  const summary=summarizeMapFrames([],null);
  assert.equal(summary.fpsMean,null);assert.equal(summary.p95Ms,null);assert.equal(summary.slowFrames,null);
});
test('static Baidu view uses the chosen center and local zoom without mutating it',()=>{
  const original={mode:'baidu',center:{lng:121.592,lat:31.189},zoom:12,heading:30,tilt:20};
  const view=mapExperimentView(original,'static',1234);
  assert.deepEqual(view,{mode:'baidu',center:{lng:121.592,lat:31.189},zoom:14,heading:0,tilt:0});
  view.center.lng=0;assert.equal(original.center.lng,121.592);assert.equal(original.zoom,12);
});
test('Baidu motion is periodic and uses degrees for heading and tilt',()=>{
  const original={mode:'baidu',center:{lng:121.592,lat:31.189},zoom:12,heading:0,tilt:0};
  const quarter=mapExperimentView(original,'motion',1000);
  assert.ok(Math.abs(quarter.heading-45)<1e-9);assert.ok(Math.abs(quarter.tilt-22.5)<1e-9);
  const first=mapExperimentView(original,'motion',0),last=mapExperimentView(original,'motion',4000);
  assert.ok(Math.abs(first.center.lng-last.center.lng)<1e-9);assert.ok(Math.abs(first.zoom-last.zoom)<1e-9);
});
test('sandbox camera uses metres and radians; it does not claim to be Baidu',()=>{
  const original={mode:'sandbox',x:10,y:20,scale:.1,heading:0};
  const view=mapExperimentView(original,'motion',1000);
  assert.equal(view.mode,'sandbox');assert.equal(view.x,230);
  assert.ok(Math.abs(view.heading-Math.PI/4)<1e-9);
  assert.equal(mapExperimentView(original,'updates',0).scale,.4);
});
test('camera zoom and scale honor renderer limits at extreme starting values',()=>{
  assert.equal(mapExperimentView({mode:'baidu',center:{lng:0,lat:0},zoom:21},'static',0).zoom,21);
  assert.equal(mapExperimentView({mode:'sandbox',x:0,y:0,scale:16},'static',0).scale,16);
});
test('upload evidence distinguishes emitted color bytes, indices, and pending final update',()=>{
  const before={uploadedBytes:100,glUploadSubmissionMs:1,stagingRevision:10,committedRevision:10};
  const after={uploadedBytes:132,glUploadSubmissionMs:1.25,stagingRevision:13,committedRevision:12};
  const summary=summarizeMapUploads(before,after,[{indexUploadedBytes:16,indexUploadSubmissionMs:.1}]);
  assert.equal(summary.uploadedBytesDelta,32);assert.equal(summary.colorUploadedBytes,16);
  assert.equal(summary.pendingAtSampleStart,false);assert.equal(summary.pendingAtSampleBoundary,true);
  assert.equal(summary.geometryAndColorUploadCpuMs,.25);assert.equal(summary.spatialIndexUploadCpuMs,.1);
});
test('unmeasured upload totals remain null and inconsistent counters do not fabricate color bytes',()=>{
  assert.equal(summarizeMapUploads(undefined,{uploadedBytes:8},[]).uploadedBytesDelta,null);
  assert.equal(summarizeMapUploads({uploadedBytes:10},{uploadedBytes:12},[{indexUploadedBytes:8}]).colorUploadedBytes,null);
});
test('declared factorial includes each independent optimization and a hidden-layer control',()=>{
  assert.deepEqual(MAP_FRAME_METHODS.map(method=>method.id),['map-only','input-pages','dirty-only','spatial-only','hybrid']);
  assert.equal(MAP_FRAME_METHODS.filter(method=>method.visible).length,4);
  assert.equal(new Set(MAP_FRAME_METHODS.filter(method=>method.visible).map(method=>`${method.spatial}/${method.dirtyMode}`)).size,4);
});
test('camera verification accepts wrapped heading while rejecting unexecuted zoom or center',()=>{
  const requested={mode:'baidu',center:{lng:121.592,lat:31.189},zoom:14,heading:-45,tilt:20};
  assert.equal(mapCameraPoseMatches(requested,{...requested,heading:315}),true);
  assert.equal(mapCameraPoseMatches(requested,{...requested,zoom:12}),false);
  assert.equal(mapCameraPoseMatches(requested,{...requested,center:{lng:121.6,lat:31.189}}),false);
  assert.equal(mapCameraPoseMatches(requested,{...requested,mode:'sandbox'}),false);
});
test('construction summary separates current-frame CPU from cumulative maxima and missing telemetry',()=>{
  const summary=summarizeBuildPreparation([
    {spatialBuildCpuMs:2,spatialBuildSliceMaxMs:.6,spatialPendingPages:2,spatialBuildMaxSliceMs:99},
    {spatialBuildCpuMs:3,spatialBuildSliceMaxMs:.8,spatialPendingPages:1},
    {spatialBuildCpuMs:0,spatialBuildSliceMaxMs:0,spatialPendingPages:0},
    {spatialBuildCpuMs:null,spatialBuildSliceMaxMs:null}
  ]);
  assert.equal(summary.buildCpuMs,5);assert.equal(summary.buildFrames,2);
  assert.equal(summary.buildCpuMaxFrameMs,3);assert.equal(summary.buildMaxSliceMs,.8);
  assert.equal(summary.pendingFrames,2);assert.equal(summarizeBuildPreparation([]).buildCpuMaxFrameMs,null);
});
test('fine preparation waits for pending work and a stable decision, including dense no-tree fallback',()=>{
  assert.equal(spatialPreparationReady({spatialSettled:true,spatialPendingPages:2},true),false);
  assert.equal(spatialPreparationReady({spatialSettled:false,spatialPendingPages:0},true),false);
  assert.equal(spatialPreparationReady({spatialSettled:true,spatialPendingPages:0,spatialFinePages:0},true),true);
  assert.equal(spatialPreparationReady({spatialSettled:true},true),false);
  assert.equal(spatialPreparationReady({},false),true);
});
