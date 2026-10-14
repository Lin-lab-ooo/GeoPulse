/** Three-way frozen 2.2 Worker-first / upper heuristic / proven-lower gate CPU comparison. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoarseSpatialIndex } from './fixtures/property-2.3/coarse-with-lower.js';
import { decideSpatialWork } from '../public/js/spatial-work-policy.js';
import { classifyProjectedBounds } from './fixtures/research-2.2/public/js/projected-bounds.js';
import { computeSourceFingerprint } from './fixtures/research-2.2/server.mjs';
import { generatePropertyCase, propertyProfile, matrix, workerChannel, reference, validateOutput } from './property-acceleration-2.3.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), FROZEN=path.join(ROOT,'tools/fixtures/research-2.2');
const BASELINE='f87bf0c83ed40b3c16e6db74c59e1c568ef89924751c18b8f1cf82447315cbb6';
const DISTRIBUTIONS=['uniform','eight-clusters','narrow-corridor','long-crossing-lines'];
const ORDERS=['spatial-arrival','shuffled-arrival','far-alternating-arrival'];
const VIEWS=[
  {name:'contained-page',x:0,y:0,width:26000,height:26000,heading:0},
  {name:'dense-partial-page',x:1000,y:0,width:10000,height:12000,heading:0},
  {name:'local-cluster',x:-4100,y:-2800,width:1200,height:1200,heading:0},
  {name:'central-small',x:0,y:0,width:800,height:800,heading:0},
  {name:'rotated-strip',x:0,y:0,width:11000,height:400,heading:Math.PI/6}
];
const median=values=>{const a=[...values].sort((a,b)=>a-b);return a.length%2?a[a.length>>1]:(a[(a.length>>1)-1]+a[a.length>>1])/2;};
const hash=value=>createHash('sha256').update(value).digest('hex');
const emptyStats=()=>({clientCopyMs:0,workerAppendMs:0,workerQueryMs:0,clientEnqueueMs:0,copyBuildQueryCpuMs:0,mirrorBytes:0,indexTypedArrayBytes:0,indexEstimatedBytes:0,workerRequests:0,workerAppends:0});
export function buildLowerCoarse(data) {
  const index=new CoarseSpatialIndex({primitiveSize:data.primitiveSize}),began=performance.now(),end=data.count*data.primitiveSize,chunk=2048*data.primitiveSize;
  for(let at=0;at<end;at+=chunk) index.append(data.positions,at,Math.min(end,at+chunk));
  return {index,buildMs:performance.now()-began};
}
function coldDecision(data,counted,variant) {
  return decideSpatialWork({primitiveCount:data.count,coarseUpperBound:counted.primitivesSelected,coarseLowerBound:counted.containedPrimitives,
    coarseComplete:true,maxCandidateRatio:.15,denseGate:variant==='upper'?'upper-heuristic':'proven-lower'});
}
export function runLowerPropertyCase(data,view,{rounds=3}={}) {
  const coarse=buildLowerCoarse(data),m=matrix(view),relation=classifyProjectedBounds(data.bounds,m),began=performance.now(),counted=coarse.index.count(b=>classifyProjectedBounds(b,m)),coarseQueryMs=performance.now()-began;
  const exact=reference(data,m);assert.ok(counted.containedPrimitives<=exact.starts.length&&exact.starts.length<=counted.primitivesSelected,'L <= bbox reference <= U');
  const upper=coldDecision(data,counted,'upper'),lower=coldDecision(data,counted,'lower');
  if(relation!==0) return {view:view.name,pageRelation:relation,action:relation===1?'contained-page':'page-cull',lowerBound:counted.containedPrimitives,upperBound:counted.primitivesSelected,bboxReferenceCount:exact.starts.length,
    scope:'No production spatial selection; not a gate saving.',baselineWorkerRequired:false};
  const measurements=[];let quality={};
  for(let round=0;round<rounds;round++) {
    const executionOrder=['baseline','upper','lower'].slice(round%3).concat(['baseline','upper','lower'].slice(0,round%3)),trial={};
    for(const variant of executionOrder) {
      const decision=variant==='baseline'?{action:'refine'}:variant==='upper'?upper:lower;
      if(decision.action==='refine') { const channel=workerChannel(data),receipt=channel.query(m).result;trial[variant]={result:receipt,stats:channel.snapshot()};channel.dispose(); }
      else trial[variant]={result:null,stats:emptyStats()};
    }
    const baseline=trial.baseline.result,baselineStarts=baseline.dense?Array.from({length:data.count},(_,i)=>i*data.primitiveSize):baseline.starts;
    for(const [variant,decision] of [['upper',upper],['lower',lower]]) {
      quality[variant]=validateOutput(data,m,trial[variant].result,decision.action,decision.action==='refine'?baselineStarts:null);
      quality[variant].coldCoarseFalseDenseAgainstFine=decision.action==='dense-fallback'&&!baseline.dense;
      if(variant==='lower'&&decision.action==='dense-fallback') {assert.equal(baseline.dense,true,'Proven dense lower bound must also make the baseline fine count dense');assert.equal(quality[variant].candidateSHA256,hash(Uint32Array.from(baselineStarts)));quality[variant].candidateIdsEqualToBaseline=true;}
    }
    measurements.push({round,executionOrder,baseline:trial.baseline.stats,upper:trial.upper.stats,lower:trial.lower.stats,
      baselineFineCount:baseline.count,baselineFineDense:baseline.dense,
      upperPairedWorkerCpuSavedMs:trial.baseline.stats.copyBuildQueryCpuMs-trial.upper.stats.copyBuildQueryCpuMs,
      lowerPairedWorkerCpuSavedMs:trial.baseline.stats.copyBuildQueryCpuMs-trial.lower.stats.copyBuildQueryCpuMs});
  }
  const summarize=variant=>({action:(variant==='upper'?upper:lower).action,reason:(variant==='upper'?upper:lower).reason,
    workerRequired:(variant==='upper'?upper:lower).action==='refine',cpuMedianMs:median(measurements.map(r=>r[variant].copyBuildQueryCpuMs)),
    pairedCpuSavedMedianMs:median(measurements.map(r=>r[variant+'PairedWorkerCpuSavedMs'])),pairedCpuSavedRangeMs:[Math.min(...measurements.map(r=>r[variant+'PairedWorkerCpuSavedMs'])),Math.max(...measurements.map(r=>r[variant+'PairedWorkerCpuSavedMs']))],quality:quality[variant]});
  return {view:view.name,pageRelation:relation,lowerBound:counted.containedPrimitives,upperBound:counted.primitivesSelected,lowerRatio:counted.containedPrimitives/data.count,upperRatio:counted.primitivesSelected/data.count,
    bboxReferenceCount:exact.starts.length,coarseQueryMs,coarseBuildMs:coarse.buildMs,coarseStats:coarse.index.getStats(),baselineWorkerRequired:true,
    baselineCpuMedianMs:median(measurements.map(r=>r.baseline.copyBuildQueryCpuMs)),upper:summarize('upper'),lower:summarize('lower'),measurements};
}
function warmTrajectory(data) {
  const coarse=buildLowerCoarse(data).index;let channel=null;const stages=[];
  for(const view of VIEWS) {const m=matrix(view),relation=classifyProjectedBounds(data.bounds,m);if(relation!==0){stages.push({view:view.name,action:relation===1?'contained-page':'page-cull'});continue;}
    const counted=coarse.count(b=>classifyProjectedBounds(b,m)),decision=decideSpatialWork({primitiveCount:data.count,coarseUpperBound:counted.primitivesSelected,coarseLowerBound:counted.containedPrimitives,coarseComplete:true,hasWorkerPage:Boolean(channel)});
    let result=null;if(decision.action==='refine'){channel??=workerChannel(data);result=channel.query(m).result;}
    const quality=validateOutput(data,m,result,decision.action);stages.push({view:view.name,action:decision.action,reason:decision.reason,lowerBound:counted.containedPrimitives,upperBound:counted.primitivesSelected,workerRetained:Boolean(channel),quality});
  }
  const stats=channel?.snapshot()??null;channel?.dispose();return {stages,worker:stats};
}
export async function runLowerPropertyExperiment({count=12000,rounds=3,seeds=[7,19,41],output='reports/property-acceleration-2.3.lower.json'}={}) {
  assert.ok(Number.isSafeInteger(count)&&count>=1000&&count<=30000);assert.ok(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=7);
  const sourceBefore=await computeSourceFingerprint(FROZEN);assert.equal(sourceBefore,BASELINE);
  const files=['tools/property-acceleration-2.3.lower.mjs','tools/property-acceleration-2.3.mjs','tools/fixtures/property-2.3/coarse-with-lower.js','public/js/spatial-work-policy.js',
    'tools/fixtures/research-2.2/public/js/coarse-spatial-index.js','tools/fixtures/research-2.2/public/js/spatial-query-worker.js','tools/fixtures/research-2.2/public/js/spatial-query-client.js'];
  const bindings=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(path.join(ROOT,file)))])));
  const report={schema:'geo-pulse/property-acceleration-lower-2.3',generatedAt:new Date().toISOString(),sourceBefore,bindings,
    methodology:{count,rounds,seeds,distributions:DISTRIBUTIONS,orders:ORDERS,views:VIEWS,candidateRatio:.15,
      comparison:'Frozen 2.2 Worker-first; cold U>rN heuristic; cold L>rN proven dense gate. Both gates prove empty from U=0. Existing fine/Worker work and moved/removed geometry bypass gating.',
      lower:'L is the sum of primitive counts in coarse buckets whose complete bounding boxes are fully inside the projected clip rectangle. L <= per-primitive bbox reference <= U, and L <= fine candidate count. Only count() adds a lower-bound field to a copied coarse fixture; the immutable 2.2 baseline is unchanged.',
      exactness:'Refine branch candidate starts equal the frozen 2.2 Worker result. Proven dense branches equal the complete-page baseline dense set. Empty branches can reduce baseline fine false positives, but preserve every reference primitive. Heuristic dense can keep extra primitives; false dense cases are retained as negative results.',
      timing:'Production client slice/copy + production Worker mirror growth, fine append/count/query and receipt handling through a queued in-process adapter. Serial CPU measurements; policy variants execute in rotated order by paired round. No actual Worker transport/scheduling, main-thread fine fallback, WebGL, GPU, SDK or FPS.',
      rendererEligibility:'Only partial page relation 0; fully-contained relation 1 and rejected relation -1 are excluded from cold-gate savings.',
      data:'Same Float32 source geometry, stable primitive IDs, arrival sequence and conservative classification in each comparison. Synthetic scenarios, not real-world distribution prevalence.',
      memory:'Exact owned typed-array bytes for Worker mirror and fine geometry, estimated JS index bytes separately. The summary is already paid for in both production policies; maintenance and query CPU are explicitly recorded.',
      warm:'A single page follows all views. Once a Worker has been created, later high or zero coarse results must not suppress its fine query.',
      experimentShape:'36 datasets x 5 views = 180 view cases; three independently cold rounds per eligible view. The 12,000-primitive pages cover one Uint16-safe page rather than claiming full multi-page renderer equivalence.'},cases:[],passed:false};
  for(const distribution of DISTRIBUTIONS)for(const seed of seeds)for(const order of ORDERS){const data=generatePropertyCase(distribution,seed,count,order),item={distribution,seed,order,geometrySHA256:hash(data.positions),idSHA256:hash(data.ids),properties:propertyProfile(data),
      views:VIEWS.map(view=>runLowerPropertyCase(data,view,{rounds})),warmTrajectory:warmTrajectory(data)};report.cases.push(item);
    process.stdout.write(JSON.stringify({distribution,seed,order,upper:item.views.map(v=>v.upper?.action??v.action),lower:item.views.map(v=>v.lower?.action??v.action),falseDense:item.views.filter(v=>v.upper?.quality.coldCoarseFalseDenseAgainstFine).length})+'\n');}
  const eligible=report.cases.flatMap(c=>c.views).filter(v=>v.pageRelation===0);
  const variantSummary=variant=>{const skipped=eligible.filter(v=>!v[variant].workerRequired),refined=eligible.filter(v=>v[variant].workerRequired);return {
    avoidedWorkerViews:skipped.length,emptyGateViews:skipped.filter(v=>v[variant].action==='empty').length,denseGateViews:skipped.filter(v=>v[variant].action==='dense-fallback').length,
    falseDenseAgainstFineViews:skipped.filter(v=>v[variant].quality.coldCoarseFalseDenseAgainstFine).length,
    skippedWorkerCpuMedianMs:skipped.length?median(skipped.map(v=>v[variant].pairedCpuSavedMedianMs)):0,
    skippedMirrorBytesMedian:skipped.length?median(skipped.map(v=>v.measurements[0].baseline.mirrorBytes)):0,skippedFineTypedArrayBytesMedian:skipped.length?median(skipped.map(v=>v.measurements[0].baseline.indexTypedArrayBytes)):0,
    refinedCandidateEqualityViews:refined.filter(v=>v[variant].quality.candidateIdsEqualToBaseline).length,
    refinedPairedCpuSavedMedianMs:refined.length?median(refined.map(v=>v[variant].pairedCpuSavedMedianMs)):0,
    allReferencePrimitivesRetained:eligible.every(v=>v[variant].quality.everyReferenceRetained)};};
  report.summary={cases:report.cases.length,views:report.cases.flatMap(c=>c.views).length,partialViews:eligible.length,upper:variantSummary('upper'),lower:variantSummary('lower'),
    retainedWorkerBypassStages:report.cases.flatMap(c=>c.warmTrajectory.stages).filter(s=>s.reason==='retained-fine-work').length,
    allWarmReferencePrimitivesRetained:report.cases.every(c=>c.warmTrajectory.stages.every(s=>!s.quality||s.quality.everyReferenceRetained))};
  assert.equal(report.summary.lower.falseDenseAgainstFineViews,0);
  for(const file of files)assert.equal(hash(await readFile(path.join(ROOT,file))),bindings[file],file+' changed during experiment');
  report.sourceAfter=await computeSourceFingerprint(FROZEN);assert.equal(report.sourceAfter,sourceBefore);report.passed=report.summary.upper.allReferencePrimitivesRetained&&report.summary.lower.allReferencePrimitivesRetained&&report.summary.allWarmReferencePrimitivesRetained;
  await writeFile(path.resolve(ROOT,output),JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
  const report=await runLowerPropertyExperiment({count:Number(args.count??12000),rounds:Number(args.rounds??3),seeds:args.seeds?args.seeds.split(',').map(Number):[7,19,41],output:args.output??'reports/property-acceleration-2.3.lower.json'});
  process.stdout.write(JSON.stringify({passed:report.passed,summary:report.summary})+'\n');}
