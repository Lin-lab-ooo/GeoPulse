/** Sealed-page reference rebuild research. No production changes, GL or SDK. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REBUILD_STRATEGIES, buildReorderedIndex } from './fixtures/spatial-rebuild-2.3.mjs';
import { generatePropertyCase, propertyProfile, matrix, reference, workerChannel } from './property-acceleration-2.3.mjs';
import { classifyProjectedBounds } from './fixtures/research-2.2/public/js/projected-bounds.js';
import { computeSourceFingerprint } from './fixtures/research-2.2/server.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),FROZEN=path.join(ROOT,'tools/fixtures/research-2.2');
const SOURCE='f87bf0c83ed40b3c16e6db74c59e1c568ef89924751c18b8f1cf82447315cbb6';
const DISTRIBUTIONS=['uniform','eight-clusters','narrow-corridor','long-crossing-lines'],ORDERS=['spatial-arrival','shuffled-arrival','far-alternating-arrival'];
const VIEWS=[
  {name:'contained-page',x:0,y:0,width:26000,height:26000,heading:0},
  {name:'dense-partial-page',x:1000,y:0,width:10000,height:12000,heading:0},
  {name:'local-cluster',x:-4100,y:-2800,width:1200,height:1200,heading:0},
  {name:'central-small',x:0,y:0,width:800,height:800,heading:0},
  {name:'rotated-strip',x:0,y:0,width:11000,height:400,heading:Math.PI/6}
];
const hash=v=>createHash('sha256').update(v).digest('hex');
const median=a=>quantile(a,.5);
function quantile(values,q){const a=[...values].sort((a,b)=>a-b);if(!a.length)return 0;const index=(a.length-1)*q,lo=Math.floor(index),hi=Math.ceil(index);return a[lo]+(a[hi]-a[lo])*(index-lo);}
function measuredQuery(index,data,view,{repeats=8}={}) {
  const m=matrix(view),classify=b=>classifyProjectedBounds(b,m),timings=[],countTimings=[],querySortTimings=[];let counted=null;
  for(let repeat=0;repeat<repeats;repeat++) {const began=performance.now(),countBegan=performance.now();counted=index.count(classify);countTimings.push(performance.now()-countBegan);
    const queryBegan=performance.now();if(counted.primitivesSelected<=data.count*.15) {const scratch=new Uint16Array(counted.primitivesSelected+1);let n=0;index.query(classify,start=>scratch[n++]=start);assert.equal(n,counted.primitivesSelected);scratch.subarray(0,n).sort();}
    querySortTimings.push(performance.now()-queryBegan);timings.push(performance.now()-began);}
  // Full conservative candidates are enumerated separately for correctness;
  // dense production queries would not enumerate them, so this cost is excluded.
  const candidates=[],visit=index.query(classify,start=>candidates.push(start));candidates.sort((a,b)=>a-b);assert.equal(visit.primitivesSelected,counted.primitivesSelected);
  const selected=new Set(candidates),exact=reference(data,m);assert.equal(selected.size,candidates.length);
  for(const start of exact.starts)assert.ok(selected.has(start),'bbox reference missing after reference-only rebuild');
  for(const start of exact.crossing)assert.ok(selected.has(start),'actual crossing line missing after rebuild');
  return {view:view.name,pageRelation:classifyProjectedBounds(data.bounds,m),bboxReferenceCount:exact.starts.length,fineCandidateCount:counted.primitivesSelected,
    falsePositiveCount:counted.primitivesSelected-exact.starts.length,falsePositiveFactor:exact.starts.length?counted.primitivesSelected/exact.starts.length:null,
    dense:counted.primitivesSelected>data.count*.15,ordinaryLOD1SubmittedPrimitives:counted.primitivesSelected>data.count*.15?data.count:counted.primitivesSelected,
    candidateStartSHA256:hash(Uint32Array.from(candidates)),allReferencesRetained:true,actualCrossingLineWithCentroidOutsideCount:exact.crossing.length,
    countNodesTested:counted.nodesTested,countCpuMedianMs:median(countTimings),queryAndSortCpuMedianMs:median(querySortTimings),policyQueryCpuMedianMs:median(timings)};
}
export function runRebuildDataset(data,{rounds=3,queryRepeats=8}={}) {
  const geometryBefore=hash(data.positions),worker=workerChannel(data),workerReceipts=VIEWS.map(view=>worker.query(matrix(view)).result);worker.dispose();
  const trial=Object.fromEntries(REBUILD_STRATEGIES.map(strategy=>[strategy,[]]));
  for(let round=0;round<rounds;round++){
    const executionOrder=REBUILD_STRATEGIES.slice(round%REBUILD_STRATEGIES.length).concat(REBUILD_STRATEGIES.slice(0,round%REBUILD_STRATEGIES.length));
    for(const strategy of executionOrder){const built=buildReorderedIndex(data.positions,{primitiveSize:data.primitiveSize,strategy,maxSplitEntries:strategy==='arrival'?Infinity:256});
      assert.equal(built.indexStats.primitives,data.count);assert.ok(built.slices.every(s=>s.primitives<=128));
      const views=VIEWS.map(view=>measuredQuery(built.index,data,view,{repeats:queryRepeats}));
      if(strategy==='arrival')for(let i=0;i<views.length;i++){assert.equal(views[i].fineCandidateCount,workerReceipts[i].count,'arrival index equals frozen actual Worker fine count');
        if(!workerReceipts[i].dense){const starts=Uint32Array.from(workerReceipts[i].starts).sort();assert.equal(views[i].candidateStartSHA256,hash(starts),'arrival candidate starts equal actual Worker');}}
      if(trial[strategy].length)for(let i=0;i<views.length;i++)assert.equal(views[i].candidateStartSHA256,trial[strategy][0].views[i].candidateStartSHA256,'deterministic repeated reconstruction');
      const sliceMs=built.slices.map(s=>s.ms);
      trial[strategy].push({round,executionOrder,totalPrepareBuildMs:built.totalPrepareBuildMs,planMs:built.plan.planMs,geometryCopyMs:built.geometryCopyMs,geometryCopyBytes:built.geometryCopyBytes,
        appendMs:built.appendMs,planTypedArrayBytes:built.plan.planTypedArrayBytes,temporaryPlanNumericSlots:built.plan.temporaryNumericSlots,rangeCount:built.plan.rangeCount,samplePrimitives:built.plan.sampleCount,
        slices:{count:sliceMs.length,p95Ms:quantile(sliceMs,.95),maxMs:Math.max(...sliceMs),maxPrimitives:Math.max(...built.slices.map(s=>s.primitives))},
        indexStats:built.indexStats,treeShape:built.treeShape,views});
    }
  }
  const baseline=trial.arrival,boundedControl=trial['arrival-bounded'],methods=Object.fromEntries(REBUILD_STRATEGIES.map(strategy=>{const rounds=trial[strategy],first=rounds[0],buildMs=median(rounds.map(r=>r.totalPrepareBuildMs));return [strategy,{
    prepareAndBuildCpuMedianMs:buildMs,planCpuMedianMs:median(rounds.map(r=>r.planMs)),copyCpuMedianMs:median(rounds.map(r=>r.geometryCopyMs)),appendCpuMedianMs:median(rounds.map(r=>r.appendMs)),
    sliceP95MedianMs:median(rounds.map(r=>r.slices.p95Ms)),sliceMaxAcrossRoundsMs:Math.max(...rounds.map(r=>r.slices.maxMs)),rangeCount:first.rangeCount,samplePrimitives:first.samplePrimitives,
    planTypedArrayBytes:first.planTypedArrayBytes,temporaryPlanNumericSlots:first.temporaryPlanNumericSlots,geometryCopyBytes:first.geometryCopyBytes,indexTypedArrayBytes:first.indexStats.typedArrayBytes,indexEstimatedBytes:first.indexStats.estimatedBytes,
    conservativePeakExtraTypedArrayBytes:first.planTypedArrayBytes+first.geometryCopyBytes+first.indexStats.typedArrayBytes,
    treeShape:first.treeShape,views:first.views.map((view,i)=>{
      const queryMs=median(rounds.map(r=>r.views[i].policyQueryCpuMedianMs)),baseQueryMs=median(baseline.map(r=>r.views[i].policyQueryCpuMedianMs)),saved=baseQueryMs-queryMs;
      const boundedQueryMs=median(boundedControl.map(r=>r.views[i].policyQueryCpuMedianMs));
      return {...view,policyQueryCpuMedianMs:queryMs,baselineQueryCpuMedianMs:baseQueryMs,queryCpuSavedPerRepeatMs:saved,
        arrivalBoundedQueryCpuMedianMs:boundedQueryMs,orderingCpuSavedVsBoundedMs:boundedQueryMs-queryMs,
        orderingFineCandidateDeltaVsBounded:view.fineCandidateCount-boundedControl[0].views[i].fineCandidateCount,
        orderingSubmittedPrimitiveDeltaVsBounded:view.ordinaryLOD1SubmittedPrimitives-boundedControl[0].views[i].ordinaryLOD1SubmittedPrimitives,
        cpuBreakEvenQueryCount:strategy==='arrival'?null:saved>0?Math.ceil(buildMs/saved):null,
        submittedPrimitiveDelta:view.ordinaryLOD1SubmittedPrimitives-baseline[0].views[i].ordinaryLOD1SubmittedPrimitives,
        ordinaryLOD1SubmittedReductionRatio:baseline[0].views[i].ordinaryLOD1SubmittedPrimitives?1-view.ordinaryLOD1SubmittedPrimitives/baseline[0].views[i].ordinaryLOD1SubmittedPrimitives:null,
        baselineFineCandidateCount:baseline[0].views[i].fineCandidateCount};}),rounds}];}));
  assert.equal(hash(data.positions),geometryBefore,'source coordinates not reordered');
  return {distribution:data.distribution,seed:data.seed,order:data.order,count:data.count,primitiveSize:data.primitiveSize,geometrySHA256:geometryBefore,idSHA256:hash(data.ids),properties:propertyProfile(data),methods,
    originalWorkerCandidateIdentityChecked:true,sourceGeometryByteUnchanged:true};
}
export async function runRebuildExperiment({count=12000,capacityCount=60000,rounds=3,queryRepeats=8,output='reports/rebuild-properties-2.3.json'}={}) {
  const sourceBefore=await computeSourceFingerprint(FROZEN);assert.equal(sourceBefore,SOURCE);assert.ok(count>=1000&&count<=30000&&capacityCount>=count&&capacityCount<=65535);
  const files=['tools/rebuild-properties-2.3.mjs','tools/fixtures/spatial-rebuild-2.3.mjs','tools/property-acceleration-2.3.mjs','tools/fixtures/research-2.2/public/js/spatial-index.js','tools/fixtures/research-2.2/public/js/spatial-query-worker.js'];
  const bindings=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(path.join(ROOT,file)))])));
  const report={schema:'geo-pulse/sealed-reference-rebuild-2.3',generatedAt:new Date().toISOString(),sourceBefore,bindings,
    methodology:{count,capacityCount,seeds:[7,19,41],orders:ORDERS,distributions:DISTRIBUTIONS,strategies:REBUILD_STRATEGIES,rounds,queryRepeats,views:VIEWS,
      material:'36 synthetic 12k complete-point/line datasets, plus nine 60k corridor point capacity datasets. Triangles, degenerate geometry and plan coverage are tested separately. No new external requests.',
      sameGeometry:'Only insertion reference ranges change. Original Float32 coordinates, IDs, vertex starts and byte order remain fixed. Original starts can still be numerically sorted for transparency. Every complete point/line/triangle range is visited once; source buffers are never packed in a new order.',
      baseline:'Frozen actual 2.2 Worker fine counts/candidates are checked against arrival insertion at the same 64/8/16 tree parameters. Arrival chunk128 is semantically identical to Worker chunk2048 because insertion order is unchanged; chunk timing is not claimed equal.',
      bounded:'Every append call contains at most128 complete primitives; rebuilt trees cap a single split to256 entries. Separate arrival-bounded control retains the same order with that cap, distinguishing cap effects from reference ordering. Infinity arrival is the true frozen Worker baseline, while current main-thread progressive construction already uses a cap. This bounds input counts and atomic sort size, not hard realtime wall time. An optional prefix uniformly samples64 original offsets, followed by contiguous bounded ranges that omit those references.',
      cost:'Measured plan creation, a conservative full Float32 snapshot copy, and full index construction. Slice p95/max include actual append call only; total build includes timer/measurement overhead. No scheduling/yield/Worker transfer, geometry upload, GPU, SDK, physical frame rate or end-to-end latency is measured.',
      memory:'Conservative extra typed-array payload while an old tree is retained = new tree geometry + snapshot positions + plan arrays. JS plan temporary numeric slots and index JS estimates are separate; not actual browser heap. Source coordinates/old mirror stay resident.',
      query:'Budgeted production-style count; enumerate/sort only if candidate count<=15%N, otherwise complete-page fallback. Correctness separately enumerates full fine candidates outside the recorded timing. Reported LOD1 submitted primitive reductions are model counts, not actual GL calls or frames.',
      breakEven:'Existing tree rebuild cost is not subtracted by old build cost. CPU-only H=ceil(rebuildCost/(oldQueryCPU-newQueryCPU)) when the denominator is positive. A sparse rebuilt query can take more CPU than a dense count-only fallback; then no CPU-only break-even is claimed. Candidate/GPU savings require browser evidence.',
      safety:'Production integration would require a sealed stable version, a separate new tree, retaining old tree/conservative draw while rebuilding, and version recheck before atomic swap. Not implemented by this research tool.'},cases:[],capacityCases:[],passed:false};
  for(const distribution of DISTRIBUTIONS)for(const seed of [7,19,41])for(const order of ORDERS){const item=runRebuildDataset(generatePropertyCase(distribution,seed,count,order),{rounds,queryRepeats});report.cases.push(item);process.stdout.write(JSON.stringify({distribution,seed,order,largestLeaf:Object.fromEntries(REBUILD_STRATEGIES.map(s=>[s,item.methods[s].treeShape.largestLeaf]))})+'\n');}
  for(const seed of [7,19,41])for(const order of ORDERS){const item=runRebuildDataset(generatePropertyCase('narrow-corridor',seed,capacityCount,order),{rounds,queryRepeats});report.capacityCases.push(item);process.stdout.write(JSON.stringify({capacity:capacityCount,seed,order,largestLeaf:Object.fromEntries(REBUILD_STRATEGIES.map(s=>[s,item.methods[s].treeShape.largestLeaf]))})+'\n');}
  const cases=[...report.cases,...report.capacityCases];report.summary={datasets:report.cases.length,capacityDatasets:report.capacityCases.length,buildTrials:cases.length*REBUILD_STRATEGIES.length*rounds,
    allSourceGeometryByteUnchanged:cases.every(c=>c.sourceGeometryByteUnchanged),allBaselineActualWorkerCandidateIdentityChecked:cases.every(c=>c.originalWorkerCandidateIdentityChecked),
    allReferencePrimitivesRetained:cases.every(c=>Object.values(c.methods).every(m=>m.views.every(v=>v.allReferencesRetained))),
    maxAppendPrimitives:Math.max(...cases.flatMap(c=>Object.values(c.methods).flatMap(m=>m.rounds.map(r=>r.slices.maxPrimitives)))),
    perStrategy:Object.fromEntries(REBUILD_STRATEGIES.map(s=>[s,{prepareBuildMedianMs:median(cases.map(c=>c.methods[s].prepareAndBuildCpuMedianMs)),
      sliceP95MedianMs:median(cases.map(c=>c.methods[s].sliceP95MedianMs)),sliceMaxMs:Math.max(...cases.map(c=>c.methods[s].sliceMaxAcrossRoundsMs)),largestLeafMedian:median(cases.map(c=>c.methods[s].treeShape.largestLeaf)),
      partialQueriesWithPositiveCpuBreakEven:cases.flatMap(c=>c.methods[s].views).filter(v=>v.pageRelation===0&&v.cpuBreakEvenQueryCount!==null).length,
      partialQueriesWithFewerLOD1Primitives:cases.flatMap(c=>c.methods[s].views).filter(v=>v.pageRelation===0&&v.submittedPrimitiveDelta<0).length,
      partialQueriesWithMoreLOD1Primitives:cases.flatMap(c=>c.methods[s].views).filter(v=>v.pageRelation===0&&v.submittedPrimitiveDelta>0).length,
      partialQueriesWithFewerLOD1PrimitivesVsBounded:cases.flatMap(c=>c.methods[s].views).filter(v=>v.pageRelation===0&&v.orderingSubmittedPrimitiveDeltaVsBounded<0).length,
      partialQueriesWithMoreLOD1PrimitivesVsBounded:cases.flatMap(c=>c.methods[s].views).filter(v=>v.pageRelation===0&&v.orderingSubmittedPrimitiveDeltaVsBounded>0).length}]))};
  for(const file of files)assert.equal(hash(await readFile(path.join(ROOT,file))),bindings[file],file+' changed during experiment');report.sourceAfter=await computeSourceFingerprint(FROZEN);assert.equal(report.sourceAfter,sourceBefore);
  report.passed=report.summary.allSourceGeometryByteUnchanged&&report.summary.allBaselineActualWorkerCandidateIdentityChecked&&report.summary.allReferencePrimitivesRetained;
  await writeFile(path.resolve(ROOT,output),JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
  const report=await runRebuildExperiment({count:Number(args.count??12000),capacityCount:Number(args.capacity??60000),rounds:Number(args.rounds??3),queryRepeats:Number(args.queryRepeats??8),output:args.output??'reports/rebuild-properties-2.3.json'});
  process.stdout.write(JSON.stringify({passed:report.passed,summary:report.summary})+'\n');}
