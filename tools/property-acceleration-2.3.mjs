/** Deterministic, property-driven cold spatial-work experiment. No SDK or GL. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoarseSpatialIndex } from './fixtures/research-2.2/public/js/coarse-spatial-index.js';
import { SpatialQueryClient } from './fixtures/research-2.2/public/js/spatial-query-client.js';
import { createSpatialQueryHandler } from './fixtures/research-2.2/public/js/spatial-query-worker.js';
import { classifyProjectedBounds } from './fixtures/research-2.2/public/js/projected-bounds.js';
import { computeSourceFingerprint } from './fixtures/research-2.2/server.mjs';
import { decideSpatialWork } from '../public/js/spatial-work-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROZEN_ROOT = path.join(ROOT, 'tools/fixtures/research-2.2');
const EXPECTED_BASELINE = 'f87bf0c83ed40b3c16e6db74c59e1c568ef89924751c18b8f1cf82447315cbb6';
const DISTRIBUTIONS = ['uniform', 'eight-clusters', 'narrow-corridor', 'long-crossing-lines'];
const ORDERS = ['spatial-arrival', 'shuffled-arrival', 'far-alternating-arrival'];
const VIEWS = [
  { name: 'contained-page', x: 0, y: 0, width: 26000, height: 26000, heading: 0 },
  { name: 'dense-partial-page', x: 1000, y: 0, width: 10000, height: 12000, heading: 0 },
  { name: 'local-cluster', x: -4100, y: -2800, width: 1200, height: 1200, heading: 0 },
  { name: 'central-small', x: 0, y: 0, width: 800, height: 800, heading: 0 },
  { name: 'rotated-strip', x: 0, y: 0, width: 11000, height: 400, heading: Math.PI / 6 }
];
const median = values => { const a = [...values].sort((a,b) => a-b); return a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1)-1]+a[a.length >> 1])/2; };
const hash = value => createHash('sha256').update(value).digest('hex');
function random(seed) { let n = seed >>> 0; return () => { n = (Math.imul(n,1664525)+1013904223)>>>0; return n / 4294967296; }; }
function bbox(positions, start, size) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i=start; i<start+size; i++) { const x=positions[i*2], y=positions[i*2+1]; minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
  return { minX, minY, maxX, maxY };
}
export function matrix(view) {
  const m = new Float64Array(16), c = Math.cos(view.heading), s = Math.sin(view.heading), sx=2/view.width, sy=2/view.height;
  m[0]=c*sx; m[4]=-s*sx; m[1]=s*sy; m[5]=c*sy; m[10]=1; m[15]=1;
  m[12]=(-c*view.x+s*view.y)*sx; m[13]=(-s*view.x-c*view.y)*sy; return m;
}
function inside(x,y,m) { return Math.abs(m[0]*x+m[4]*y+m[12]) <= 1 && Math.abs(m[1]*x+m[5]*y+m[13]) <= 1; }
function lineIntersectsClip(positions,start,m) {
  const ax=m[0]*positions[start*2]+m[4]*positions[start*2+1]+m[12], ay=m[1]*positions[start*2]+m[5]*positions[start*2+1]+m[13];
  const bx=m[0]*positions[(start+1)*2]+m[4]*positions[(start+1)*2+1]+m[12], by=m[1]*positions[(start+1)*2]+m[5]*positions[(start+1)*2+1]+m[13];
  let lo=0,hi=1;
  for(const [a,d] of [[ax,bx-ax],[ay,by-ay]]) { if(!d) { if(a < -1 || a > 1) return false; continue; } const t0=(-1-a)/d,t1=(1-a)/d; lo=Math.max(lo,Math.min(t0,t1)); hi=Math.min(hi,Math.max(t0,t1)); if(lo>hi) return false; }
  return true;
}
export function generatePropertyCase(distribution, seed, count=12000, order='shuffled-arrival') {
  assert.ok(DISTRIBUTIONS.includes(distribution)); assert.ok(ORDERS.includes(order));
  const rng=random(seed), gaussian=()=>Math.sqrt(-2*Math.log(Math.max(rng(),1e-12)))*Math.cos(2*Math.PI*rng());
  const centers=[[-4100,-2800],[-1500,-3000],[2000,-2800],[4200,-500],[2000,1000],[-1000,1000],[-3800,2800],[700,3800]];
  const size=distribution==='long-crossing-lines'?2:1, original=new Float32Array(count*size*2), coordinates=[];
  for(let id=0;id<count;id++) {
    let x,y,coords;
    if(distribution==='uniform') { x=(rng()-.5)*11200; y=(rng()-.5)*11200; }
    else if(distribution==='eight-clusters') { const c=centers[Math.floor(rng()*8)]; x=c[0]+gaussian()*180; y=c[1]+gaussian()*140; }
    else if(distribution==='narrow-corridor') { x=(rng()-.5)*11200; y=gaussian()*38; }
    else { y=(rng()-.5)*11200; coords=[-5900,y-(rng()-.5)*900,900+rng()*5000,y+(rng()-.5)*900]; }
    if(!coords) coords=[x,y]; original.set(coords,id*size*2);
    const b=bbox(original,id*size,size); coordinates.push({id,cx:(b.minX+b.maxX)/2,cy:(b.minY+b.maxY)/2});
  }
  const ids=coordinates.map(p=>p.id);
  ids.sort((a,b)=>Math.floor(coordinates[a].cx/256)-Math.floor(coordinates[b].cx/256)||Math.floor(coordinates[a].cy/256)-Math.floor(coordinates[b].cy/256)||a-b);
  if(order==='shuffled-arrival') { const shuffle=random(seed^0x75E259AD); for(let i=ids.length-1;i;i--) { const j=Math.floor(shuffle()*(i+1)); [ids[i],ids[j]]=[ids[j],ids[i]]; } }
  if(order==='far-alternating-arrival') { ids.sort((a,b)=>coordinates[a].cx-coordinates[b].cx||a-b); const alt=[]; for(let lo=0,hi=ids.length-1;lo<=hi;lo++,hi--) { alt.push(ids[lo]); if(lo!==hi)alt.push(ids[hi]); } ids.splice(0,ids.length,...alt); }
  const positions=new Float32Array(original.length); for(let i=0;i<count;i++) positions.set(original.subarray(ids[i]*size*2,(ids[i]+1)*size*2),i*size*2);
  return { distribution,seed,order,count,primitiveSize:size,positions,ids:Uint32Array.from(ids),bounds:bbox(positions,0,count*size) };
}
export function propertyProfile(data) {
  const {positions,primitiveSize:size,count}=data, cells=new Map(); let meanX=0,meanY=0,xx=0,yy=0,xy=0,cross=0,adjacentDistance=0;
  const centers=[];
  for(let i=0;i<count;i++) { const b=bbox(positions,i*size,size),x=(b.minX+b.maxX)/2,y=(b.minY+b.maxY)/2; centers.push([x,y]); meanX+=x; meanY+=y; const key=Math.floor(x/100)+','+Math.floor(y/100); cells.set(key,(cells.get(key)||0)+1); if(Math.floor(b.minX/256)!==Math.floor(b.maxX/256)||Math.floor(b.minY/256)!==Math.floor(b.maxY/256)) cross++; if(i)adjacentDistance+=Math.hypot(x-centers[i-1][0],y-centers[i-1][1]); }
  meanX/=count;meanY/=count; for(const [x,y] of centers) { xx+=(x-meanX)**2; yy+=(y-meanY)**2; xy+=(x-meanX)*(y-meanY); }
  xx/=count; yy/=count; xy/=count; const root=Math.hypot(xx-yy,2*xy),major=(xx+yy+root)/2,minor=(xx+yy-root)/2;
  return { primitiveCount:count,primitiveSize:size,occupied100mCenterCells:cells.size,hottest100mCenterCell:Math.max(...cells.values()),meanPrimitivesPerOccupied100mCenterCell:count/cells.size,
    centerCovarianceEigenvalueRatio:minor>0?major/minor:null,centerRmsMajorMeters:Math.sqrt(major),centerRmsMinorMeters:Math.sqrt(Math.max(0,minor)),
    completeBoundsCrossing256mCellRatio:cross/count,meanArrivalAdjacentCenterDistanceMeters:adjacentDistance/Math.max(1,count-1) };
}
function coarseIndex(data) {
  const index=new CoarseSpatialIndex({primitiveSize:data.primitiveSize}), began=performance.now(), end=data.count*data.primitiveSize,chunk=2048*data.primitiveSize;
  for(let at=0;at<end;at+=chunk) index.append(data.positions,at,Math.min(end,at+chunk));
  return {index,buildMs:performance.now()-began};
}
/** Executes the production client copies and production Worker mirror/index handler.
 * The queued in-process adapter intentionally measures CPU, not a Worker thread,
 * cross-thread transport/scheduling, GL submissions, or map frame rate.
 */
export function workerChannel(data) {
  const queue=[],acks=[],worker={onmessage:null,onerror:null,postMessage:m=>queue.push(m),terminate:()=>{}};
  const handler=createSpatialQueryHandler(m=>{acks.push(m);worker.onmessage?.({data:m});});
  const client=new SpatialQueryClient({createWorker:()=>worker}); let clientCopyMs=0,workerAppendMs=0,workerQueryMs=0,clientEnqueueMs=0;
  const processQueue=()=>{while(queue.length) { const m=queue.shift(),began=performance.now();handler.onmessage({data:m}); const duration=performance.now()-began; if(m.type==='append')workerAppendMs+=duration; if(m.type==='query')workerQueryMs+=duration; }};
  let began=performance.now(); client.register('page',{primitiveSize:data.primitiveSize,options:{leafSize:64,minExtent:8,maxDepth:16},dataVersion:1});clientEnqueueMs+=performance.now()-began;processQueue();
  const end=data.count*data.primitiveSize,chunk=2048*data.primitiveSize;
  for(let at=0;at<end;at+=chunk) { began=performance.now();client.append('page',data.positions,at,Math.min(end,at+chunk),{dataVersion:1});clientCopyMs+=performance.now()-began;processQueue(); }
  assert.equal(client.stats.errors,0);assert.equal(client.pages.get('page').indexedUntil,end);
  return { query(m,ratio=.15) { const query={matrix:m,marginX:1,marginY:1,candidateBudget:data.count*ratio},before=workerQueryMs; const at=performance.now();client.query('page',query);clientEnqueueMs+=performance.now()-at;processQueue();const result=client.latest('page',query);assert.ok(result&&!result.stale);return {result,handlerCpuMs:workerQueryMs-before}; },
    snapshot() { const indexed=acks.filter(m=>m.type==='indexed').at(-1);return {clientCopyMs,workerAppendMs,workerQueryMs,clientEnqueueMs,copyBuildQueryCpuMs:clientCopyMs+workerAppendMs+workerQueryMs+clientEnqueueMs,
      mirrorBytes:handler.stats.mirrorBytes,indexTypedArrayBytes:indexed?.index.typedArrayBytes??0,indexEstimatedBytes:indexed?.index.estimatedBytes??0,workerRequests:handler.stats.queries,workerAppends:handler.stats.appends}; },dispose:()=>client.dispose() };
}
export function reference(data,m) {
  const starts=[],crossing=[];for(let start=0;start<data.count*data.primitiveSize;start+=data.primitiveSize) { const b=bbox(data.positions,start,data.primitiveSize);if(classifyProjectedBounds(b,m)!==-1)starts.push(start);
    if(data.primitiveSize===2&&lineIntersectsClip(data.positions,start,m)&&!inside((b.minX+b.maxX)/2,(b.minY+b.maxY)/2,m))crossing.push(start); }
  return {starts,crossing};
}
export function validateOutput(data,m,result,action,expectedFine=null) {
  const exact=reference(data,m), starts=action==='empty'?[]:action==='dense-fallback'||result?.dense?Array.from({length:data.count},(_,i)=>i*data.primitiveSize):Array.from(result?.starts??[]).sort((a,b)=>a-b),selected=new Set(starts);
  for(const start of exact.starts)assert.ok(selected.has(start),'full primitive bbox reference disappeared');for(const start of exact.crossing)assert.ok(selected.has(start),'actual crossing segment disappeared');
  if(expectedFine) assert.deepEqual(starts,[...expectedFine].sort((a,b)=>a-b));
  return {bboxReferenceCount:exact.starts.length,selectedCount:starts.length,extraPrimitivesAboveBBoxReference:starts.length-exact.starts.length,
    actualCrossingLineWithCentroidOutsideCount:exact.crossing.length,crossingSampleStarts:exact.crossing.slice(0,8),candidateSHA256:hash(Uint32Array.from(starts)),candidateIdsEqualToBaseline:expectedFine?true:null,
    everyReferenceRetained:true,fullGeometrySHA256:hash(data.positions)};
}
export function runPropertyCase(data,view,{ratio=.15,rounds=3}={}) {
  const m=matrix(view),relation=classifyProjectedBounds(data.bounds,m),coarse=coarseIndex(data),coarseBegan=performance.now(),counted=coarse.index.count(b=>classifyProjectedBounds(b,m)),coarseQueryMs=performance.now()-coarseBegan;
  const decision=decideSpatialWork({primitiveCount:data.count,coarseUpperBound:counted.primitivesSelected,coarseComplete:true,maxCandidateRatio:ratio,denseGate:'upper-heuristic'});
  if(relation!==0) return {view:view.name,pageRelation:relation,action:relation===1?'contained-page':'page-cull',coarseUpperBound:counted.primitivesSelected,coarseQueryMs,
    baselineWorkerRequired:false,gatedWorkerRequired:false,workerCpuSavedMs:0,scope:'Renderer would bypass spatial selection for this page; not counted as a cold-gate saving.'};
  const measurements=[];let quality=null,falseDense=false;
  for(let round=0;round<rounds;round++) {
    const runWorker=()=> { const channel=workerChannel(data),result=channel.query(m,ratio).result,stats=channel.snapshot();channel.dispose();return {result,stats}; };
    let baselineTrial,gatedTrial=null;
    if(decision.action==='refine'&&round%2===1) { gatedTrial=runWorker();baselineTrial=runWorker(); }
    else { baselineTrial=runWorker();if(decision.action==='refine')gatedTrial=runWorker(); }
    const baselineReceipt={result:baselineTrial.result},baselineStats=baselineTrial.stats;
    const baselineStarts=baselineReceipt.result.dense?Array.from({length:data.count},(_,i)=>i*data.primitiveSize):baselineReceipt.result.starts;
    let gatedStats={clientCopyMs:0,workerAppendMs:0,workerQueryMs:0,clientEnqueueMs:0,copyBuildQueryCpuMs:0,mirrorBytes:0,indexTypedArrayBytes:0,indexEstimatedBytes:0,workerRequests:0,workerAppends:0},gatedReceipt=null;
    if(decision.action==='refine') { gatedReceipt=gatedTrial.result;gatedStats=gatedTrial.stats;quality=validateOutput(data,m,gatedReceipt,'refine',baselineStarts); }
    else { quality=validateOutput(data,m,null,decision.action);falseDense=decision.action==='dense-fallback'&&!baselineReceipt.result.dense; }
    measurements.push({round,baseline:baselineStats,gated:gatedStats,workerCpuSavedMs:baselineStats.copyBuildQueryCpuMs-gatedStats.copyBuildQueryCpuMs,
      executionOrder:decision.action==='refine'&&round%2===1?'gated-baseline':'baseline-gated',
      baselineWorkerCandidateCount:baselineReceipt.result.count,baselineWorkerDense:baselineReceipt.result.dense});
  }
  return {view:view.name,pageRelation:relation,action:decision.action,reason:decision.reason,coarseUpperBound:counted.primitivesSelected,coarseUpperRatio:counted.primitivesSelected/data.count,
    coarseQueryMs,coarseBuildMs:coarse.buildMs,coarseBucketsTested:counted.bucketsTested,coarseStats:coarse.index.getStats(),baselineWorkerRequired:true,gatedWorkerRequired:decision.action==='refine',
    baselineCpuMedianMs:median(measurements.map(r=>r.baseline.copyBuildQueryCpuMs)),gatedCpuMedianMs:median(measurements.map(r=>r.gated.copyBuildQueryCpuMs)),
    pairedWorkerCpuSavedMedianMs:median(measurements.map(r=>r.workerCpuSavedMs)),pairedWorkerCpuSavedRangeMs:[Math.min(...measurements.map(r=>r.workerCpuSavedMs)),Math.max(...measurements.map(r=>r.workerCpuSavedMs))],
    coldCoarseFalseDenseAgainstFine:falseDense,quality,measurements};
}
function trajectory(data,coarse) {
  let channel=null; const stages=[];
  for(const view of VIEWS) { const m=matrix(view),relation=classifyProjectedBounds(data.bounds,m);
    if(relation!==0) { stages.push({view:view.name,action:relation===1?'contained-page':'page-cull'});continue; }
    const counted=coarse.count(b=>classifyProjectedBounds(b,m)),decision=decideSpatialWork({primitiveCount:data.count,coarseUpperBound:counted.primitivesSelected,coarseComplete:true,hasWorkerPage:Boolean(channel),denseGate:'upper-heuristic'});
    let receipt=null;if(decision.action==='refine') { channel??=workerChannel(data);receipt=channel.query(m).result; }
    const validation=validateOutput(data,m,receipt,decision.action);
    stages.push({view:view.name,action:decision.action,reason:decision.reason,coarseUpperBound:counted.primitivesSelected,workerRetained:Boolean(channel),quality:validation});
  }
  const stats=channel?.snapshot()??null;channel?.dispose();return {stages,worker:stats};
}
export async function runPropertyExperiment({count=12000,rounds=3,seeds=[7,19,41],output='reports/property-acceleration-2.3.json'}={}) {
  assert.ok(Number.isSafeInteger(count)&&count>=1000&&count<=30000);assert.ok(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=7);
  const sourceBefore=await computeSourceFingerprint(FROZEN_ROOT);assert.equal(sourceBefore,EXPECTED_BASELINE,'frozen 2.2 source identity');
  const scriptPaths=['tools/property-acceleration-2.3.mjs','public/js/spatial-work-policy.js','tools/fixtures/research-2.2/public/js/spatial-query-worker.js','tools/fixtures/research-2.2/public/js/spatial-query-client.js','tools/fixtures/research-2.2/public/js/coarse-spatial-index.js'];
  const bindings=Object.fromEntries(await Promise.all(scriptPaths.map(async file=>[file,hash(await readFile(path.join(ROOT,file)))])));
  const report={schema:'geo-pulse/property-acceleration-2.3',generatedAt:new Date().toISOString(),sourceBefore,bindings,methodology:{count,rounds,seeds,distributions:DISTRIBUTIONS,orders:ORDERS,views:VIEWS,maxCandidateRatio:.15,
    gate:'Only cold lazy-build pages with a complete, unmoved summary. A zero upper bound proves empty; a high upper bound keeps the complete page/ordinary LOD and defers fine work. Existing Worker pages and fine trees bypass the gate.',
    rendererEligibility:'Page relation -1 and 1 bypass spatial selection, matching production. Only partially visible relation 0 pages enter this experiment.',
    timing:'CPU of production client slice/copies + actual 2.2 Worker mirror growth, PrimitiveSpatialIndex append/count/query and receipt handling, executed through an in-process queued adapter. Both policies already have the same production coarse summary. No real Worker thread scheduling, cross-thread transport latency, main-thread fine fallback, GL, pixels, SDK or frame rate are measured.',
    candidateEquality:'Refine branches are compared start-by-start to identical production Worker baselines. Gated branches may contain extra invisible primitives; every complete bbox reference and every actual segment crossing the affine viewport is retained. These are conservative candidate guarantees, not pixel equality or draw-count equivalence.',
    coldRounds:'Each partial page/view/round begins without any Worker or fine index. Baseline always copies/builds/queries before its existing coarse decision. Cold gate can avoid this scheduled background work. Refine branch execution order alternates each paired round. In real frames its CPU runs partly off-thread; it is not all main-thread savings.',
    warmTrajectory:'The same page moves through all five cameras; once it has a Worker, subsequent high/zero coarse results cannot suppress that more precise Worker path.',
    data:'Synthetic page-size scenarios with original Float32 coordinates, complete points or complete long lines; not an empirical industrial workload prevalence estimate.',
    bounds:'Exact typed-array payload for Worker mirror/fine geometry, plus explicitly estimated JS index bytes. Not browser heap or GPU memory. No source geometry is reordered by production.'},cases:[],passed:false};
  for(const distribution of DISTRIBUTIONS)for(const seed of seeds)for(const order of ORDERS) { const data=generatePropertyCase(distribution,seed,count,order),coarse=coarseIndex(data);
    const item={distribution,seed,order,geometrySHA256:hash(data.positions),idSHA256:hash(data.ids),properties:propertyProfile(data),views:VIEWS.map(view=>runPropertyCase(data,view,{rounds})),warmTrajectory:trajectory(data,coarse.index)};
    report.cases.push(item);process.stdout.write(JSON.stringify({distribution,seed,order,actions:item.views.map(v=>v.action),falseDense:item.views.filter(v=>v.coldCoarseFalseDenseAgainstFine).length})+'\n');
  }
  const views=report.cases.flatMap(c=>c.views),eligible=views.filter(v=>v.pageRelation===0),gated=eligible.filter(v=>!v.gatedWorkerRequired),retained=report.cases.flatMap(c=>c.warmTrajectory.stages).filter(s=>s.reason==='retained-fine-work');
  report.summary={cases:report.cases.length,views:views.length,partialViews:eligible.length,coldGateAvoidedWorkerViews:gated.length,emptyGateViews:gated.filter(v=>v.action==='empty').length,denseGateViews:gated.filter(v=>v.action==='dense-fallback').length,
    falseDenseAgainstFineViews:gated.filter(v=>v.coldCoarseFalseDenseAgainstFine).length,refineCandidateEqualityViews:eligible.filter(v=>v.quality?.candidateIdsEqualToBaseline).length,retainedWorkerBypassStages:retained.length,
    avoidedWorkerCpuMedianAcrossGatedViewsMs:gated.length?median(gated.map(v=>v.pairedWorkerCpuSavedMedianMs)):0,
    avoidedMirrorBytesMedian:gated.length?median(gated.map(v=>v.measurements[0].baseline.mirrorBytes)):0,
    avoidedFineTypedArrayBytesMedian:gated.length?median(gated.map(v=>v.measurements[0].baseline.indexTypedArrayBytes)):0,
    allReferencePrimitivesRetained:eligible.every(v=>v.quality.everyReferenceRetained)&&report.cases.every(c=>c.warmTrajectory.stages.every(s=>!s.quality||s.quality.everyReferenceRetained))};
  const sourceAfter=await computeSourceFingerprint(FROZEN_ROOT);assert.equal(sourceAfter,sourceBefore);
  for(const file of scriptPaths)assert.equal(hash(await readFile(path.join(ROOT,file))),bindings[file],file+' changed during experiment');
  report.sourceAfter=sourceAfter;report.passed=report.summary.allReferencePrimitivesRetained;
  await writeFile(path.resolve(ROOT,output),JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const argv=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
  const report=await runPropertyExperiment({count:Number(argv.count??12000),rounds:Number(argv.rounds??3),seeds:argv.seeds?argv.seeds.split(',').map(Number):[7,19,41],output:argv.output??'reports/property-acceleration-2.3.json'});
  process.stdout.write(JSON.stringify({passed:report.passed,summary:report.summary})+'\n');
}
