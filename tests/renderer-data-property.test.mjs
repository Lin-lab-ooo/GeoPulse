/** Renderer integration for conservative data properties; GL recording is not a GPU benchmark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingRenderer } from './helpers/recording-renderer.mjs';
import { CoarseSpatialIndex } from '../public/js/coarse-spatial-index.js';

const NORMAL=[20,130,220,180], UPDATED=[40,150,230,180];
const VIEW={x:100,y:100,scale:6,heading:0};
function points(count,coordinate=()=>[100,100]) {
  const positions=new Float32Array(count*2),colors=new Uint8Array(count*4),ids=new Uint32Array(count);
  for(let i=0;i<count;i++){positions.set(coordinate(i),i*2);colors.set(NORMAL,i*4);ids[i]=i+1;}
  return {kind:'points',positions,colors,ids,featureCount:count};
}
function fixture(options={}){
  const f=createRecordingRenderer();f.renderer.setAdaptive(false);
  f.renderer.setOptimizationOptions({spatialPolicy:'always',spatialBuildExecution:'synchronous',...options});return f;
}
function attachWorkerSpy(renderer,existingPage=null){
  const calls={ensure:0,register:0,append:0,query:0};
  const client={pages:new Map(),stats:{lastTransportMs:0},
    register(id,options){calls.register++;this.pages.set(id,{generation:1,dataVersion:options.dataVersion,indexedUntil:0});},
    append(id,_positions,_start,end,options){calls.append++;const entry=this.pages.get(id);entry.indexedUntil=end;entry.dataVersion=options.dataVersion;},
    latest(){return null;},query(){calls.query++;},dispose(){this.pages.clear();}};
  renderer._spatialQueryClient=client;
  renderer._ensureSpatialQueryClient=()=>{calls.ensure++;return client;};
  if(existingPage){existingPage.workerId='retained-page';existingPage.workerMirrored=existingPage.count;client.pages.set(existingPage.workerId,{generation:1,dataVersion:existingPage.dataVersion,indexedUntil:existingPage.count});}
  return {calls,client};
}
function colorFixture(count=2048,options={}){
  const f=fixture({spatial:false,colorUploadPolicy:'density',...options});
  f.renderer.append({groups:[points(count)]});f.render(VIEW);return f;
}
const colorRanges=frame=>frame.uploads.filter(u=>u.channel==='color').map(u=>[u.offset,u.offset+u.byteLength]);
function assertCovered(ranges,dirty){for(const [a,b]of dirty)assert.ok(ranges.some(([x,y])=>x<=a&&y>=b),`unsubmitted dirty bytes [${a},${b})`);}
function alternatingColors(f,count){const ids=Array.from({length:count},(_,i)=>i*2+1);f.renderer.trackFeatures(ids);f.renderer.updateFeatureColors(ids.map(id=>({id,color:UPDATED})));return ids.map(id=>[(id-1)*4,id*4]);}

test('cold contained-dense pages draw conservatively before any Worker register, copy or query',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%50?[100+i%8,100]:[900,900])]});
    const {calls}=attachWorkerSpy(f.renderer),frame=f.render(VIEW),page=f.renderer.pages.points[0];
    assert.deepEqual(calls,{ensure:0,register:0,append:0,query:0});assert.equal(page.spatial,null);
    assert.equal(frame.submittedVertices,2000);assert.equal(page.selection.coarseGuard,true);assert.ok(frame.stats.coarseDensityGuardPages>0);
  }finally{f.dispose();}
});

test('cold empty middle of a large page avoids Worker startup and submits zero vertices',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%2?[900,900]:[100,100])]});
    const {calls}=attachWorkerSpy(f.renderer),frame=f.render({x:500,y:500,scale:6,heading:0}),page=f.renderer.pages.points[0];
    assert.deepEqual(calls,{ensure:0,register:0,append:0,query:0});assert.equal(page.spatial,null);assert.equal(frame.submittedVertices,0);assert.equal(page.selection.coarseEmpty,true);
    assert.ok(frame.stats.coarseBucketsTested>0,'the page itself overlapped; its coarse buckets proved empty');
  }finally{f.dispose();}
});

test('high coarse upper bound and low contained lower bound still refine narrow visible points',()=>{
  const f=fixture({leafSize:8,minExtent:0});try{
    f.renderer.append({groups:[points(10000,i=>i<10?[130,100]:i%2?[145,100]:[900,900])]});
    const view={...VIEW,scale:10};Object.assign(f.renderer.camera,view);const page=f.renderer.pages.points[0];
    const coarse=page.coarse.count(b=>f.renderer._classifyBounds(b,f.renderer._localMatrix()));
    assert.ok(coarse.primitivesSelected>page.count*f.renderer.optimization.maxCandidateRatio);
    assert.ok(coarse.containedPrimitives<=page.count*f.renderer.optimization.maxCandidateRatio);
    const {calls}=attachWorkerSpy(f.renderer),frame=f.render(view);
    assert.equal(calls.register,1);assert.equal(calls.append,1);assert.equal(calls.query,1);assert.ok(page.spatial);assert.equal(frame.submittedVertices,10);assert.equal(frame.stats.coarseDensityGuardPages,0);
  }finally{f.dispose();}
});

test('retained fine indexes bypass a loose coarse decision',()=>{
  const f=fixture({spatialBuildPolicy:'eager',spatialQueryWorker:false});try{
    f.renderer.append({groups:[points(2000,i=>i%100?[900,900]:[100,100])]});const page=f.renderer.pages.points[0],tree=page.spatial;
    f.renderer.setOptimizationOptions({spatialBuildPolicy:'lazy'});page.coarse.count=()=>assert.fail('retained fine page must bypass coarse gate');
    const frame=f.render(VIEW);assert.equal(page.spatial,tree);assert.equal(frame.submittedVertices,20);assert.equal(frame.stats.coarseBucketsTested,0);
  }finally{f.dispose();}
});

test('registered Worker membership bypasses the cold gate while an orphan id remains cold',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%100?[900,900]:[100,100])]});const page=f.renderer.pages.points[0];
    const {calls}=attachWorkerSpy(f.renderer,page);page.coarse.count=()=>assert.fail('registered Worker page must bypass coarse gate');
    const frame=f.render(VIEW);assert.equal(calls.ensure,1);assert.equal(calls.register,0);assert.equal(calls.append,0);assert.equal(calls.query,1);assert.equal(frame.submittedVertices,20);
  }finally{f.dispose();}
  const cold=fixture();try{
    cold.renderer.append({groups:[points(2000,i=>i%50?[100,100]:[900,900])]});cold.renderer.pages.points[0].workerId='failed-registration';const {calls}=attachWorkerSpy(cold.renderer);
    const frame=cold.render(VIEW);assert.equal(calls.ensure,0);assert.equal(frame.submittedVertices,2000);assert.equal(cold.renderer.pages.points[0].selection.coarseGuard,true);
  }finally{cold.dispose();}
});

test('incomplete coarse watermarks cannot discard an unrepresented visible tail',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%100?[900,900]:[100,100])]});const page=f.renderer.pages.points[0];
    page.coarseIndexedUntil=page.count-1;page.coarse.count=()=>assert.fail('incomplete coarse summary must bypass cold gate');
    const {calls}=attachWorkerSpy(f.renderer),frame=f.render(VIEW);assert.equal(calls.register,1);assert.equal(frame.submittedVertices,20);
  }finally{f.dispose();}
});

test('live movement out of a cold empty coarse snapshot becomes drawable before Worker readiness',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%2?[900,900]:[100,100])]});f.renderer.trackFeatures([1]);
    const view={x:500,y:500,scale:6,heading:0};assert.equal(f.render(view).submittedVertices,0);
    const page=f.renderer.pages.points[0];assert.equal(page.spatial,null);f.renderer.updateFeaturePositions([{id:1,x:500,y:500}]);
    page.coarse.count=()=>assert.fail('moved geometry must bypass stale coarse snapshot');const {calls}=attachWorkerSpy(f.renderer),frame=f.render(view);
    assert.equal(calls.register,1);assert.equal(frame.submittedVertices,1);assert.ok(Array.from(page.indices.subarray(0,page.indexCount)).includes(0));
    assert.equal(frame.uploads.filter(u=>u.channel==='position').reduce((n,u)=>n+u.byteLength,0),8);
  }finally{f.dispose();}
});

test('tombstones bypass cold coarse decisions and remain zero-alpha in a dense fallback',()=>{
  const f=fixture();try{
    f.renderer.append({groups:[points(2000,i=>i%50?[100,100]:[900,900])]});f.renderer.trackFeatures([2]);f.renderer.removeFeatures([2]);const page=f.renderer.pages.points[0];
    page.coarse.count=()=>assert.fail('removed geometry must bypass cold coarse snapshot');const {calls}=attachWorkerSpy(f.renderer),frame=f.render(VIEW);
    assert.equal(calls.register,1);assert.equal(page.colors[7],0);assert.equal(page.overlayRemoved.size,1);assert.ok(frame.submittedVertices>0);
  }finally{f.dispose();}
});

test('long crossing segments and triangles are not rejected by outside centers or high upper counts',()=>{
  for(const [kind,primitiveSize]of [['lines',2],['polygons',3]]){
    const f=fixture();try{
      const count=100,positions=new Float32Array(count*primitiveSize*2),colors=new Uint8Array(count*primitiveSize*4),ids=new Uint32Array(count*primitiveSize);
      for(let i=0;i<count;i++){
        const y=-10+i%20,xy=primitiveSize===2?[-1000,y,1800,y]:[-1000,y,1800,y,1800,y+20];positions.set(xy,i*primitiveSize*2);
        for(let v=0;v<primitiveSize;v++){colors.set(NORMAL,(i*primitiveSize+v)*4);ids[i*primitiveSize+v]=i+1;}
      }
      f.renderer.append({groups:[{kind,positions,colors,ids,featureCount:count}]});const {calls}=attachWorkerSpy(f.renderer),frame=f.render({x:0,y:0,scale:6,heading:0});
      assert.equal(calls.register,1);assert.equal(frame.submittedVertices,count*primitiveSize);assert.equal(frame.stats.coarseDensityGuardPages,0);
    }finally{f.dispose();}
  }
});

test('density color integration preserves distant two-point eight-byte updates and adjacent single calls',()=>{
  const f=colorFixture(6000);try{
    f.renderer.trackFeatures([101,102,6000]);f.renderer.updateFeatureColors([{id:101,color:UPDATED},{id:6000,color:UPDATED}]);let frame=f.render(VIEW);
    assert.equal(frame.colorUploadBytes,8);assert.equal(frame.colorUploadCalls,2);assert.equal(frame.uploads.filter(u=>u.channel==='position').length,0);assert.equal(f.renderer._densityUploadPlanner,undefined);
    f.renderer.updateFeatureColors([{id:101,color:[41,150,230,180]},{id:102,color:[41,150,230,180]}]);frame=f.render(VIEW);
    assert.equal(frame.colorUploadBytes,8);assert.equal(frame.colorUploadCalls,1);assert.deepEqual(colorRanges(frame),[[400,408]]);
  }finally{f.dispose();}
});

test('many dense RGBA edits reach density planning, upload bounded bytes and preserve every dirty slot',()=>{
  const f=colorFixture(2048);try{
    const dirty=alternatingColors(f,1024),frame=f.render(VIEW);assert.equal(frame.colorUploadCalls,1);assert.equal(frame.colorUploadBytes,2048*4);assert.ok(frame.colorUploadBytes<=dirty.length*4*2);assertCovered(colorRanges(frame),dirty);
    assert.equal(typeof f.renderer._densityUploadPlanner,'function');assert.equal(frame.uploads.filter(u=>u.channel==='position').length,0);
    assert.equal(f.render(VIEW).colorUploadBytes,0,'planner scratch and dirty intervals reset for the next clean frame');
  }finally{f.dispose();}
});

test('hundreds of repeated overlapping color edits cannot turn two unique slots into a full-page upload',()=>{
  const f=colorFixture(2048);try{
    f.renderer.trackFeatures([1,101]);for(let i=0;i<256;i++)f.renderer.updateFeatureColors([{id:1,color:[31+i%2,150,230,180]},{id:101,color:[31+i%2,150,230,180]}]);
    const frame=f.render(VIEW);assert.equal(frame.colorUploadBytes,8);assert.equal(frame.colorUploadCalls,2);assertCovered(colorRanges(frame),[[0,4],[400,404]]);assert.equal(f.renderer.pages.points[0].colors[0],32);assert.equal(f.renderer.pages.points[0].colors[400],32);
  }finally{f.dispose();}
});

test('legacy, envelope and custom gaps retain their specified upload semantics',()=>{
  for(const [options,expectedCalls,expectedBytes]of [[{colorUploadPolicy:'legacy'},1,4092],[{dirtyMode:'envelope'},1,4092],[{mergeGapBytes:0},32,3968]]){
    const f=colorFixture(1024,options);try{const dirty=alternatingColors(f,512),frame=f.render(VIEW);assert.equal(frame.colorUploadCalls,expectedCalls);assert.equal(frame.colorUploadBytes,expectedBytes);assertCovered(colorRanges(frame),dirty);assert.equal(f.renderer._densityUploadPlanner,undefined);}finally{f.dispose();}
  }
});

test('color density policy leaves many position edits on the eight-byte legacy planner',()=>{
  const f=colorFixture(1024);try{
    const ids=Array.from({length:512},(_,i)=>i*2+1);f.renderer.trackFeatures(ids);f.renderer.updateFeaturePositions(ids.map((id,i)=>({id,x:101+i*.001,y:100})));
    const frame=f.render(VIEW),positions=frame.uploads.filter(u=>u.channel==='position');assert.equal(positions.length,1);assert.equal(positions[0].byteLength,8184);assert.equal(frame.colorUploadBytes,0);assert.equal(f.renderer._densityUploadPlanner,undefined);
  }finally{f.dispose();}
});
test('production coarse counts bound brute full-bbox intersections below and above for points, segments and triangles',()=>{
  let seed=317;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const boundsOf=(positions,start,size)=>{let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(let v=start;v<start+size;v++){minX=Math.min(minX,positions[v*2]);maxX=Math.max(maxX,positions[v*2]);minY=Math.min(minY,positions[v*2+1]);maxY=Math.max(maxY,positions[v*2+1]);}return{minX,minY,maxX,maxY};};
  const classify=view=>b=>b.maxX<view[0]||b.minX>view[2]||b.maxY<view[1]||b.minY>view[3]?-1:b.minX>=view[0]&&b.maxX<=view[2]&&b.minY>=view[1]&&b.maxY<=view[3]?1:0;
  for(const size of [1,2,3]){
    const n=2048,positions=new Float32Array(n*size*2);
    for(let i=0;i<n;i++){
      const x=(random()-.5)*600+(i%3===1?1200:0),y=(random()-.5)*600+(i%3===1?1200:0);
      let xy=size===1?[x,y]:size===2?[x,y,x+12,y+8]:[x,y,x+12,y,x,y+8];
      if(size>1&&i%3===2)xy=size===2?[-1800,y,2200,y]:[-1800,y,2200,y,2200,y+20];positions.set(xy,i*size*2);
    }
    const coarse=new CoarseSpatialIndex({primitiveSize:size,maxBuckets:8});for(let start=0;start<n*size;start+=73*size)coarse.append(positions,start,Math.min(n*size,start+73*size));
    assert.ok(coarse.getStats().merges>0);assert.ok(coarse.getStats().buckets<=8);
    for(const view of [[-5000,-5000,5000,5000],[-100,-100,100,100],[-5000,-20,5000,20],[1700,1700,1900,1900]]){
      const classifier=classify(view);let exact=0;for(let start=0;start<n*size;start+=size)if(classifier(boundsOf(positions,start,size))!==-1)exact++;
      const result=coarse.count(classifier);assert.ok(Number.isSafeInteger(result.containedPrimitives));assert.ok(result.containedPrimitives<=exact,`size${size} lower must prove contained full primitives`);assert.ok(exact<=result.primitivesSelected,`size${size} upper must keep every full bbox intersection`);assert.ok(result.primitivesSelected<=n);
    }
    const all=coarse.count(()=>1);assert.equal(all.containedPrimitives,n);assert.equal(all.primitivesSelected,n);
    const intersectOnly=coarse.count(()=>0);assert.equal(intersectOnly.containedPrimitives,0);assert.equal(intersectOnly.primitivesSelected,n);
    const none=coarse.count(()=>-1);assert.equal(none.containedPrimitives,0);assert.equal(none.primitivesSelected,0);
  }
});