import test from 'node:test';
import assert from 'node:assert/strict';
import {LoadingTrialCollector} from '../public/js/loading-experiment.js';
const view={mode:'sandbox',x:0,y:0,scale:.1,heading:0},rect={width:800,height:400,dpr:1};
function fixture(){let actual={...view};const renderer={matrix:Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),getViewState:()=>({...actual}),setViewState(v){actual={...v};}};const c=new LoadingTrialCollector({renderer,trial:{count:100,mode:'fixed',repeat:1},started:1000,baseView:view,initialRect:rect,getRect:()=>rect,clock:()=>2000,referenceMs:10,longTaskSupported:true});return {c,renderer};}
function frame(f,at,features=100){f.renderer.matrix[12]+=.01;f.c.onBusinessFrame({features,totalVertices:features,vertices:features,drawCalls:1,frameMs:1,stagingRevision:1,committedRevision:1},1000+at);}
test('collector exposes the terminal callback gap without modifying original samples or cadence',()=>{
 const f=fixture();f.c.sampleRaf(1010);frame(f,20,10);f.c.sampleRaf(1030);frame(f,40);f.c.setEOF({atMs:900,source:'fixture'});
 const r=f.c.finish({record:{metrics:{features:100,vertices:100,dataDoneMs:1000}},endedAt:2050});
 assert.equal(r.valid,true);assert.equal(r.raf.samples,2);assert.equal(r.raf.maxMs,20);assert.equal(r.windowCoverage.raf.callbacks,2);assert.equal(r.windowCoverage.raf.callbacksPerSecond,2);assert.equal(r.windowCoverage.raf.unclosedTailMs,970);assert.equal(r.windowCoverage.business.unclosedTailMs,960);assert.equal(f.c.rafSamples.length,2);assert.equal(r.loadingEndMs,1000);
});
test('callbacks after data-ready boundary do not conceal the earlier terminal gap',()=>{
 const f=fixture();f.c.sampleRaf(1010);frame(f,20);f.c.sampleRaf(1030);frame(f,40);f.c.setEOF({atMs:900,source:'fixture'});f.c.sampleRaf(2040);frame(f,1050);
 const r=f.c.finish({record:{metrics:{features:100,vertices:100,dataDoneMs:1000}},endedAt:2100});
 assert.equal(r.raf.samples,2);assert.equal(r.windowCoverage.raf.unclosedTailMs,970);assert.equal(r.windowCoverage.raf.callbacksPerSecond,2);assert.equal(f.c.rafSamples.length,3);
});
test('cancelled windows remain invalid while retaining their actual observed coverage',()=>{
 const f=fixture();f.c.sampleRaf(1010);frame(f,20,10);f.c.setEOF({atMs:25,source:'fixture'});
 const r=f.c.finish({status:'cancelled',record:{metrics:{features:10,vertices:10}},endedAt:1100});
 assert.equal(r.valid,false);assert.ok(r.invalidReasons.some(x=>x.code==='trial-incomplete'));assert.equal(r.windowCoverage.raf.windowMs,100);assert.equal(r.windowCoverage.raf.callbacksPerSecond,10);assert.equal(r.windowCoverage.raf.unclosedTailMs,90);
});
